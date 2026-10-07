import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { RegisterTelegramIdentityWrite } from '@nakh/application';
import type { CancelAccountDeletionCommand, RequestAccountDeletionCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { PostgresIdentityStore } from './identity-store.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const key = randomBytes(32);
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
function command(userId: string, token: string): RequestAccountDeletionCommand {
  const id = randomUUID();
  return {
    commandId: id,
    commandType: 'account.delete',
    schemaVersion: 1,
    actor: { kind: 'user', userId },
    requestId: randomUUID(),
    idempotencyKey: `m8-delete:${id}`,
    occurredAt: '2000-01-01T00:00:00Z',
    locale: 'en',
    data: { confirmationToken: token, expectedAccountVersion: 1 },
  };
}
describe.skipIf(databaseUrl === undefined)('M8 atomic confirmed deletion admission', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  function store(): PostgresAccountDeletionStore {
    return new PostgresAccountDeletionStore(database, {
      activeKeyId: 'm8-test',
      keys: new Map([['m8-test', key]]),
    });
  }
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(databaseUrl!, 'nakh_m8_deletion');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function fixture(): Promise<RegisterTelegramIdentityWrite> {
    const write = start(String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)));
    await new PostgresIdentityStore(database).registerTelegramIdentity(write);
    return write;
  }
  async function prepared(userId: string): Promise<RequestAccountDeletionCommand> {
    const proof = await store().prepare({
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      expectedAccountVersion: 1,
    });
    return command(userId, proof.confirmationToken);
  }
  async function counts(
    userId: string,
  ): Promise<{ records: string; receipts: string; work: string; events: string; audits: string }> {
    return (
      await sql<{
        records: string;
        receipts: string;
        work: string;
        events: string;
        audits: string;
      }>`SELECT
      (SELECT count(*)::text FROM identity.account_deletion_records WHERE user_id=${userId}::uuid) AS records,
      (SELECT count(*)::text FROM identity.account_deletion_commands WHERE user_id=${userId}::uuid) AS receipts,
      (SELECT count(*)::text FROM identity.account_deletion_work work JOIN identity.account_deletion_records record
        ON record.id=work.deletion_record_id WHERE record.user_id=${userId}::uuid) AS work,
      (SELECT count(*)::text FROM platform.outbox_events event JOIN identity.account_deletion_records record
        ON record.event_id=event.id WHERE record.user_id=${userId}::uuid) AS events,
      (SELECT count(*)::text FROM platform.audit_logs WHERE subject_id=${userId}::uuid
        AND event_type='account.deletion-requested.v1') AS audits`.execute(database)
    ).rows[0]!;
  }
  it('replays twenty preparations, derives only for the owner and preserves unexpired rotation authority', async () => {
    const f = await fixture(),
      query = {
        actor: { kind: 'user' as const, userId: f.userId },
        requestId: randomUUID(),
        expectedAccountVersion: 1,
      };
    const proofs = await Promise.all(Array.from({ length: 20 }, () => store().prepare(query)));
    expect(new Set(proofs.map((p) => p.confirmationToken)).size).toBe(1);
    const rotated = new PostgresAccountDeletionStore(database, {
      activeKeyId: 'm8-next',
      keys: new Map([
        ['m8-test', key],
        ['m8-next', randomBytes(32)],
      ]),
    });
    expect(await rotated.prepare(query)).toEqual(proofs[0]);
    const other = await fixture();
    await expect(
      store().request(command(other.userId, proofs[0]!.confirmationToken)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(store().prepare({ ...query, expectedAccountVersion: 2 })).rejects.toMatchObject({
      status: 409,
    });
    const row = (
      await sql<{ token_hash: string }>`SELECT token_hash FROM identity.deletion_confirmations
      WHERE user_id=${f.userId}::uuid`.execute(database)
    ).rows[0]!;
    expect(row.token_hash).toBe(
      createHash('sha256').update(proofs[0]!.confirmationToken).digest('hex'),
    );
    expect(row.token_hash).not.toBe(proofs[0]!.confirmationToken);
  });
  it('tombstones once across twenty retries with required evidence and permanently replayable receipts', async () => {
    const f = await fixture(),
      c = await prepared(f.userId);
    await database
      .updateTable('identity.guest_preview_counters')
      .set({ preview_count: 7, first_preview_at: new Date(), last_preview_at: new Date() })
      .where('user_id', '=', f.userId)
      .execute();
    const results = await Promise.all(Array.from({ length: 20 }, () => store().request(c)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    for (const result of results)
      expect(result).toMatchObject({
        accountVersion: 2,
        status: { phase: 'shared_closure', completedAt: null, returnDecision: 'purge_pending' },
      });
    expect(await counts(f.userId)).toEqual({
      records: '1',
      receipts: '1',
      work: '1',
      events: '1',
      audits: '1',
    });
    expect(await new PostgresIdentityStore(database).getByUserId(f.userId)).toMatchObject({
      accountState: 'deleted',
      guestPreviewCount: 7,
      visibilityEnabled: false,
    });
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select('username')
        .where('user_id', '=', f.userId)
        .executeTakeFirst(),
    ).toEqual({ username: null });
    await database
      .deleteFrom('platform.idempotency_records')
      .where('scope', '=', 'account.delete')
      .execute();
    expect(await store().request(c)).toMatchObject({ replayed: true, accountVersion: 2 });
    await expect(
      store().request({ ...c, data: { ...c.data, expectedAccountVersion: 2 } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store().request({ ...c, idempotencyKey: `another:${randomUUID()}` }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store().status({ actor: c.actor, requestId: randomUUID() })).toEqual(
      results[0]!.status,
    );
    const other = await fixture();
    expect(
      await store().status({
        actor: { kind: 'user', userId: other.userId },
        requestId: randomUUID(),
      }),
    ).toBeUndefined();
    await expect(
      sql`DELETE FROM identity.account_deletion_commands WHERE user_id=${f.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE identity.account_deletion_records SET reactivation_allowed=true WHERE user_id=${f.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE identity.account_deletion_records SET phase='verification',checkpoint_version=2 WHERE user_id=${f.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
  });
  it('arbitrates confirm/cancel and prevents cancelled authority reuse across processes', async () => {
    for (let n = 0; n < 6; n++) {
      const f = await fixture(),
        c = await prepared(f.userId);
      const cancel: CancelAccountDeletionCommand = {
        ...c,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: `cancel:${randomUUID()}`,
        commandType: 'account.cancel-deletion',
      };
      const results = await Promise.allSettled(
        n % 2 === 0
          ? [store().cancel(cancel), store().request(c)]
          : [store().request(c), store().cancel(cancel)],
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const proof = (
        await sql<{
          status: string;
        }>`SELECT status FROM identity.deletion_confirmations WHERE user_id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      if (proof.status === 'cancelled') {
        expect(await store().cancel(cancel)).toEqual({ cancelled: true, replayed: true });
        await expect(store().request(c)).rejects.toMatchObject({ status: 409 });
        expect((await counts(f.userId)).records).toBe('0');
      } else {
        expect(proof.status).toBe('consumed');
        expect((await counts(f.userId)).records).toBe('1');
        await expect(store().cancel(cancel)).rejects.toMatchObject({ status: 409 });
      }
    }
    const f = await fixture(),
      c = await prepared(f.userId);
    const cancel: CancelAccountDeletionCommand = { ...c, commandType: 'account.cancel-deletion' };
    expect(await store().cancel(cancel)).toEqual({ cancelled: true, replayed: false });
    await expect(
      store().request({ ...c, commandId: randomUUID(), idempotencyKey: `new:${randomUUID()}` }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('consumes a confirmation once across twenty distinct commands and serializes foreign command-ID collisions', async () => {
    const f = await fixture(),
      c = await prepared(f.userId);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        store().request(command(f.userId, c.data.confirmationToken)),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(19);
    expect(await counts(f.userId)).toEqual({
      records: '1',
      receipts: '1',
      work: '1',
      events: '1',
      audits: '1',
    });
    await expect(
      sql`DELETE FROM identity.account_deletion_work WHERE deletion_record_id IN
      (SELECT id FROM identity.account_deletion_records WHERE user_id=${f.userId}::uuid)`.execute(
        database,
      ),
    ).rejects.toThrow();
    const first = await fixture(),
      second = await fixture(),
      a = await prepared(first.userId),
      b = await prepared(second.userId);
    const collision = await Promise.allSettled([
      store().request(a),
      store().request({ ...b, commandId: a.commandId }),
    ]);
    expect(collision.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = collision.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { status: 409, message: 'error.command.idempotency_conflict' },
    });
  });
  it('expires authority using database time and permits a fresh preparation without replaying the old token', async () => {
    const f = await fixture(),
      token = randomBytes(32).toString('base64url'),
      requestId = randomUUID();
    await sql`INSERT INTO identity.deletion_confirmations
      (id,user_id,request_id,account_version,key_id,token_hash,created_at,expires_at)
      VALUES (${randomUUID()}::uuid,${f.userId}::uuid,${requestId}::uuid,1,'m8-test',
        ${createHash('sha256').update(token).digest('hex')},clock_timestamp()-interval '6 minutes',clock_timestamp()-interval '2 minutes')`.execute(
      database,
    );
    await expect(store().request(command(f.userId, token))).rejects.toMatchObject({ status: 409 });
    await expect(
      store().prepare({
        actor: { kind: 'user', userId: f.userId },
        requestId,
        expectedAccountVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await prepared(f.userId);
    expect(fresh.data.confirmationToken).not.toBe(token);
    expect(await store().request(fresh)).toMatchObject({ replayed: false });
  });
  it.each(['audit', 'event', 'work'] as const)(
    'rolls back the entire tombstone when required %s persistence fails',
    async (kind) => {
      const f = await fixture(),
        c = await prepared(f.userId);
      // Isolated database only; suppress one required insert to exercise the deferred admission guard.
      const table =
        kind === 'audit'
          ? 'platform.audit_logs'
          : kind === 'event'
            ? 'platform.outbox_events'
            : 'identity.account_deletion_work';
      await sql`CREATE FUNCTION identity.m8_test_drop_admission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_TABLE_NAME='account_deletion_work' THEN RETURN NULL; END IF;
      IF NEW.event_type='account.deletion-requested.v1' THEN RETURN NULL; END IF;
      RETURN NEW; END $$`.execute(database);
      try {
        await sql`CREATE TRIGGER m8_test_admission_failure BEFORE INSERT ON ${sql.table(table)}
        FOR EACH ROW EXECUTE FUNCTION identity.m8_test_drop_admission()`.execute(database);
        await expect(store().request(c)).rejects.toThrow();
        expect(await counts(f.userId)).toEqual({
          records: '0',
          receipts: '0',
          work: '0',
          events: '0',
          audits: '0',
        });
        expect(
          await database
            .selectFrom('identity.accounts')
            .select(['state', 'version'])
            .where('user_id', '=', f.userId)
            .executeTakeFirst(),
        ).toEqual({ state: 'guest', version: 1 });
        expect(
          (
            await sql<{
              status: string;
            }>`SELECT status FROM identity.deletion_confirmations WHERE user_id=${f.userId}::uuid`.execute(
              database,
            )
          ).rows[0]!.status,
        ).toBe('pending');
      } finally {
        await sql`DROP TRIGGER IF EXISTS m8_test_admission_failure ON ${sql.table(table)}`.execute(
          database,
        );
        await sql`DROP FUNCTION identity.m8_test_drop_admission()`.execute(database);
      }
      expect(await store().request(c)).toMatchObject({ replayed: false });
    },
  );
  it('allows banned deletion while retaining its safety bar and withholding return authority', async () => {
    const f = await fixture();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'banned' })
      .where('user_id', '=', f.userId)
      .execute();
    const c = await prepared(f.userId);
    expect(await store().request(c)).toMatchObject({ status: { returnDecision: 'purge_pending' } });
    expect(
      (
        await sql<{
          safety_bar: string;
          reactivation_allowed: boolean;
        }>`SELECT safety_bar,reactivation_allowed
      FROM identity.account_deletion_records WHERE user_id=${f.userId}::uuid`.execute(database)
      ).rows[0],
    ).toEqual({ safety_bar: 'banned', reactivation_allowed: false });
  });
  it('lets Account-first writers finish their User FK while start waits for the account', async () => {
    const f = await fixture(),
      next = start(f.command.data.telegramUserId);
    let pending: Promise<unknown> | undefined;
    await database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', f.userId)
        .forUpdate()
        .execute();
      pending = new PostgresIdentityStore(database).registerTelegramIdentity(next);
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = (
          await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_locks lock
          WHERE NOT lock.granted AND lock.locktype='transactionid'
          AND lock.transactionid=(SELECT transactionid FROM pg_locks WHERE pid=pg_backend_pid()
            AND locktype='transactionid' AND mode='ExclusiveLock' LIMIT 1)) AS waiting`.execute(tx)
        ).rows[0]!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await tx
        .insertInto('identity.account_state_history')
        .values({
          id: randomUUID(),
          user_id: f.userId,
          previous_state: 'guest',
          next_state: 'restricted',
          reason_code: 'm8_lock_probe',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          changed_at: new Date(),
        })
        .execute();
      await tx
        .updateTable('identity.accounts')
        .set({ state: 'restricted', version: 2 })
        .where('user_id', '=', f.userId)
        .execute();
    });
    await expect(pending).resolves.toMatchObject({
      context: { accountState: 'restricted', accountVersion: 2 },
    });
  });
});
