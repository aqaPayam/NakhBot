import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegisterTelegramIdentityWrite, AccountControlActor } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresIdentityStore } from './identity-store.js';
import { PostgresAccountControlSessionStore } from './account-control-session-store.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
function start(telegramId: string): RegisterTelegramIdentityWrite {
  const id = randomUUID(),
    at = new Date();
  return {
    command: {
      commandId: id,
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
      requestId: randomUUID(),
      idempotencyKey: `m8-native:${id}`,
      occurredAt: at.toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: telegramId },
      data: { telegramUserId: telegramId, updateId: id, username: 'before_deletion' },
    },
    userId: randomUUID(),
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    registrationEventId: randomUUID(),
    startRouteEventId: randomUUID(),
    processedAt: at,
    guestPreviewLimit: 10,
    defaultLocale: 'en',
  };
}

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'native limited account controls and deletion commit fences',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_account_control');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 15000,
      });
    });
    afterAll(async () => {
      await database?.destroy();
      await isolated?.destroy();
    });
    async function fixture(): Promise<{ userId: string; productEpoch: number }> {
      const write = start(
        String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)),
      );
      await new PostgresIdentityStore(database).registerTelegramIdentity(write);
      return { userId: write.userId, productEpoch: 0 };
    }
    const secrets = {
      activeKeyId: 'm8-control-test',
      keys: new Map([['m8-control-test', Buffer.alloc(32, 107)]]),
    };
    function scoped(actor: AccountControlActor): PostgresAccountDeletionStore {
      return new PostgresAccountDeletionStore(database, secrets, actor);
    }
    async function authority(
      life: { userId: string; productEpoch: number },
      seconds = 900,
    ): Promise<AccountControlActor> {
      const store = new PostgresAccountControlSessionStore(database, seconds),
        grant = (await store.issue(life, randomUUID()))!;
      expect(grant).toBeDefined();
      return {
        ...life,
        kind: 'user' as const,
        scope: 'account_control' as const,
        controlGrantId: grant.id,
      };
    }
    it('serializes twenty issuance retries into one immutable grant and revokes without product confusion', async () => {
      const life = await fixture(),
        requestId = randomUUID(),
        controls = new PostgresAccountControlSessionStore(database);
      const grants = await Promise.all(
        Array.from({ length: 20 }, () => controls.issue(life, requestId)),
      );
      expect(new Set(grants.map((g) => g!.id)).size).toBe(1);
      const grant = grants[0]!;
      expect(await controls.current(life, grant.id)).toEqual(grant);
      expect(await new PostgresUserSessionStore(database).current(life, grant.id)).toBeUndefined();
      await Promise.all(
        Array.from({ length: 20 }, () => controls.revoke(life, grant.id, randomUUID())),
      );
      expect(await controls.current(life, grant.id)).toBeUndefined();
      expect(await controls.issue(life, requestId)).toBeUndefined();
      const rows = await database
        .selectFrom('platform.audit_logs')
        .select('event_type')
        .where('subject_id', '=', grant.id)
        .execute();
      expect(rows.map((r) => r.event_type).sort()).toEqual([
        'identity.account-control-issued.v1',
        'identity.account-control-revoked.v1',
      ]);
    });
    it('keeps own status and exact deletion replay after tombstone while normal product grants stop immediately', async () => {
      const life = await fixture(),
        actor = await authority(life),
        store = scoped(actor);
      const products = new PostgresUserSessionStore(database),
        product = (await products.issue(life, randomUUID()))!;
      const query = {
        actor: { kind: 'user' as const, userId: life.userId },
        requestId: randomUUID(),
        expectedAccountVersion: 1,
      };
      const proofs = await Promise.all(Array.from({ length: 20 }, () => store.prepare(query)));
      expect(new Set(proofs.map((p) => p.confirmationToken)).size).toBe(1);
      const command = {
        commandId: randomUUID(),
        commandType: 'account.delete' as const,
        schemaVersion: 1 as const,
        actor: query.actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { confirmationToken: proofs[0]!.confirmationToken, expectedAccountVersion: 1 },
      };
      const results = await Promise.all(Array.from({ length: 20 }, () => store.request(command)));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await products.current(life, product.id)).toBeUndefined();
      expect(
        await new PostgresAccountControlSessionStore(database).current(life, actor.controlGrantId),
      ).toBeDefined();
      const status = await store.status({ actor: query.actor, requestId: randomUUID() });
      expect(Object.keys(status!).sort()).toEqual([
        'completedAt',
        'phase',
        'requestedAt',
        'returnDecision',
      ]);
      expect(status).toMatchObject({ phase: 'shared_closure', returnDecision: 'purge_pending' });
      expect(await store.request(command)).toMatchObject({ replayed: true });
      expect(
        (
          await sql<{
            blocked: boolean;
          }>`SELECT platform.deletion_operational_blocker(${life.userId}::uuid) AS blocked`.execute(
            database,
          )
        ).rows[0]!.blocked,
      ).toBe(false);
      expect(
        (
          await sql<{
            id: string;
          }>`SELECT id FROM identity.account_deletion_records WHERE user_id=${life.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
    });
    it('rejects owner substitution, stale epochs and revoked controls on prepare, status and cancellation', async () => {
      const life = await fixture(),
        actor = await authority(life),
        other = await fixture(),
        store = scoped(actor);
      await expect(
        store.prepare({
          actor: { kind: 'user', userId: other.userId },
          requestId: randomUUID(),
          expectedAccountVersion: 1,
        }),
      ).rejects.toMatchObject({ status: 401 });
      const proof = await store.prepare({
        actor: { kind: 'user', userId: life.userId },
        requestId: randomUUID(),
        expectedAccountVersion: 1,
      });
      await new PostgresAccountControlSessionStore(database).revoke(
        life,
        actor.controlGrantId,
        randomUUID(),
      );
      await expect(
        store.status({ actor: { kind: 'user', userId: life.userId }, requestId: randomUUID() }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        store.cancel({
          actor: { kind: 'user', userId: life.userId },
          commandId: randomUUID(),
          commandType: 'account.cancel-deletion',
          schemaVersion: 1,
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { confirmationToken: proof.confirmationToken, expectedAccountVersion: 1 },
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        await new PostgresAccountControlSessionStore(database).issue(
          { ...life, productEpoch: 1 },
          randomUUID(),
        ),
      ).toBeUndefined();
      const row = (
        await sql<{
          status: string;
        }>`SELECT status FROM identity.deletion_confirmations WHERE user_id=${life.userId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      expect(row.status).toBe('pending');
    });
    it('denies malformed audit grants and foreign revocations without accepting a token-shaped fact', async () => {
      const life = await fixture(),
        other = await fixture(),
        actor = await authority(life);
      await expect(
        database
          .updateTable('platform.audit_logs')
          .set({ metadata: { productEpoch: 1 } })
          .where('id', '=', actor.controlGrantId)
          .execute(),
      ).rejects.toBeDefined();
      const id = randomUUID(),
        request = randomUUID();
      await expect(
        sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,request_id,command_id,occurred_at)
   VALUES(${id}::uuid,'security','identity.account-control-revoked.v1','user',${other.userId}::uuid,'account_control',${actor.controlGrantId}::uuid,'revoked',1,'{}',${request}::uuid,${request}::uuid,clock_timestamp())`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        await new PostgresAccountControlSessionStore(database).current(life, actor.controlGrantId),
      ).toBeDefined();
    });
    it('rejects suppressed issuance and revocation instead of claiming unaudited authority', async () => {
      const life = await fixture(),
        controls = new PostgresAccountControlSessionStore(database),
        existing = (await controls.issue(life, randomUUID()))!;
      await sql`CREATE FUNCTION identity.test_suppress_control() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type IN('identity.account-control-issued.v1','identity.account-control-revoked.v1') THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER zz_test_suppress_control BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION identity.test_suppress_control()`.execute(
        database,
      );
      try {
        await expect(
          new PostgresAccountControlSessionStore(database).issue(life, randomUUID()),
        ).rejects.toBeDefined();
        await expect(controls.revoke(life, existing.id, randomUUID())).rejects.toBeDefined();
        expect(await controls.current(life, existing.id)).toBeDefined();
      } finally {
        await sql`DROP TRIGGER zz_test_suppress_control ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION identity.test_suppress_control()`.execute(database);
      }
    });
    it('rolls back preparation when real authority expires at deferred commit, proving the fault path ran', async () => {
      const life = await fixture(),
        actor = await authority(life, 10),
        store = scoped(actor);
      await sql`CREATE SEQUENCE identity.test_control_expiry_seen`.execute(database);
      await sql`CREATE FUNCTION identity.test_wait_control_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN
   PERFORM nextval('identity.test_control_expiry_seen');
   SELECT (metadata->>'expiresAt')::timestamptz INTO expiry FROM platform.audit_logs WHERE id=current_setting('nakh.account_control_grant')::uuid;
   PERFORM pg_sleep(greatest(0,extract(epoch FROM expiry-clock_timestamp())+0.1)); RETURN NULL; END $$`.execute(
        database,
      );
      await sql`CREATE CONSTRAINT TRIGGER aa_test_wait_control_expiry AFTER INSERT ON identity.deletion_confirmations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.test_wait_control_expiry()`.execute(
        database,
      );
      try {
        await expect(
          store.prepare({
            actor: { kind: 'user', userId: life.userId },
            requestId: randomUUID(),
            expectedAccountVersion: 1,
          }),
        ).rejects.toMatchObject({ code: '23514' });
        const seen = (
          await sql<{
            is_called: boolean;
          }>`SELECT is_called FROM identity.test_control_expiry_seen`.execute(database)
        ).rows[0]!;
        expect(seen.is_called).toBe(true);
        expect(
          (
            await sql<{
              id: string;
            }>`SELECT id FROM identity.deletion_confirmations WHERE user_id=${life.userId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          await new PostgresAccountControlSessionStore(database).current(
            life,
            actor.controlGrantId,
          ),
        ).toBeUndefined();
      } finally {
        await sql`DROP TRIGGER aa_test_wait_control_expiry ON identity.deletion_confirmations`.execute(
          database,
        );
        await sql`DROP FUNCTION identity.test_wait_control_expiry()`.execute(database);
        await sql`DROP SEQUENCE identity.test_control_expiry_seen`.execute(database);
      }
    });
    it('rejects old grants and old issuance request IDs after privileged epoch corruption (not approved Return)', async () => {
      const life = await fixture(),
        controls = new PostgresAccountControlSessionStore(database),
        request = randomUUID(),
        grant = (await controls.issue(life, request))!;
      await database.transaction().execute(async (tx) => {
        await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
        try {
          await tx
            .updateTable('identity.accounts')
            .set({ product_epoch: 1 })
            .where('user_id', '=', life.userId)
            .execute();
        } finally {
          await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
        }
      });
      expect(await controls.current(life, grant.id)).toBeUndefined();
      expect(await controls.issue({ ...life, productEpoch: 1 }, request)).toBeUndefined();
      expect(await controls.issue({ ...life, productEpoch: 1 }, randomUUID())).toBeDefined();
    });
  },
);
