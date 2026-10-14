import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountDeletionLease,
  DeletionEphemeralOperation,
  DeletionEphemeralObservation,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createEphemeralDeletionFixture } from './testing/ephemeral-deletion-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import { PostgresAccountDeletionSessionStore } from './account-deletion-session-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresLegacyOpaqueRetirementAudit } from './legacy-opaque-retirement-audit.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'M8 durable ephemeral passes and independent native checkpoint',
  () => {
    let database: NakhDatabase,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      store: PostgresAccountDeletionEphemeralStore,
      work: PostgresAccountDeletionWorkStore;
    const prefix = 'm8-native-ephemeral',
      evidence = 'a'.repeat(64);
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_ephemeral_passes');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      store = new PostgresAccountDeletionEphemeralStore(database, prefix, evidence);
      work = new PostgresAccountDeletionWorkStore(database);
    });
    afterAll(async () => {
      await database?.destroy();
      await isolated?.destroy();
    });
    beforeEach(async () => {
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
        database,
      );
    });
    async function scene(revoke = true): Promise<AccountDeletionLease> {
      const item = await createEphemeralDeletionFixture(database, async (userId) => {
        await new PostgresUserSessionStore(database).issue(
          { userId, productEpoch: 0 },
          randomUUID(),
        );
      });
      if (revoke) await new PostgresAccountDeletionSessionStore(database).revokeNext(item.lease);
      return item.lease;
    }
    async function claim(lease: AccountDeletionLease): Promise<DeletionEphemeralOperation> {
      const result = await store.claimNext(lease);
      expect(result.done).toBe(false);
      expect(result.operation).toBeDefined();
      return result.operation!;
    }
    function empty(op: DeletionEphemeralOperation): DeletionEphemeralObservation {
      return {
        cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
        more: false,
        found: 0,
      };
    }
    async function finishPages(lease: AccountDeletionLease): Promise<void> {
      for (let n = 0; n < 20; n++) {
        const next = await store.claimNext(lease);
        if (next.done) return;
        expect(next.operation).toBeDefined();
        await store.complete(lease, next.operation!.id, empty(next.operation!));
      }
      throw new Error('Native pass did not converge.');
    }
    it('requires revoked session authority, all six passes and mandatory independent phase proof', async () => {
      const lease = await scene(false);
      await expect(store.claimNext(lease)).rejects.toBeDefined();
      expect(await store.finish(lease)).toEqual({ completed: false });
      await new PostgresAccountDeletionSessionStore(database).revokeNext(lease);
      await finishPages(lease);
      expect(await store.finish(lease)).toEqual({ completed: true });
      expect(await store.finish(lease)).toEqual({ completed: true });
      expect(
        (
          await sql`SELECT phase,checkpoint_version,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([
        {
          phase: 'retention_manifest',
          checkpoint_version: 6,
          completed_at: null,
          reactivation_allowed: false,
        },
      ]);
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::integer AS count FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
            database,
          )
        ).rows[0]!.count,
      ).toBe(6);
    });
    it('allocates one provider operation under twenty claims and one immutable observation under twenty retries', async () => {
      const lease = await scene();
      const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimNext(lease)));
      const operations = claims.flatMap((row) => (row.operation ? [row.operation] : []));
      expect(operations).toHaveLength(1);
      const op = operations[0]!;
      await Promise.all(Array.from({ length: 20 }, () => store.complete(lease, op.id, empty(op))));
      await expect(
        store.complete(lease, op.id, { ...empty(op), more: true }),
      ).rejects.toBeDefined();
      expect((await claim(lease)).stage).toBe('owned_verify');
      await expect(
        sql`DELETE FROM identity.account_deletion_ephemeral_pages WHERE id=${op.id}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });
    it('retains findings across every page and restarts a complete independent pass', async () => {
      const lease = await scene();
      let op = await claim(lease);
      await store.complete(lease, op.id, empty(op));
      op = await claim(lease);
      expect(op.stage).toBe('owned_verify');
      await store.complete(lease, op.id, { cursor: '42', more: true, found: 1 });
      op = await claim(lease);
      expect(op.cursor).toBe('42');
      await store.complete(lease, op.id, empty(op));
      op = await claim(lease);
      expect(op.stage).toBe('owned_remove');
      expect(op.cursor).toBe('0');
      await store.complete(lease, op.id, empty(op));
      for (let n = 0; n < 3; n++) {
        op = await claim(lease);
        await store.complete(lease, op.id, empty(op));
      }
      op = await claim(lease);
      expect(op.stage).toBe('queue_normalize');
      await store.complete(lease, op.id, {
        cursor: { redisCursor: '42', pendingKeys: [`${prefix}:domain-events:${randomUUID()}`] },
        more: true,
        found: 1,
      });
      op = await claim(lease);
      await store.complete(lease, op.id, empty(op));
      op = await claim(lease);
      expect(op.stage).toBe('queue_normalize');
      expect(op.cursor).toEqual({ redisCursor: '0', pendingKeys: [] });
      await store.complete(lease, op.id, empty(op));
      await finishPages(lease);
      expect(await store.finish(lease)).toEqual({ completed: true });
    });
    it('resumes an interrupted intent under a new generation and explicitly reverifies uncertainty without inventing effect counts', async () => {
      let lease = await scene();
      const old = await claim(lease);
      const legacyHash = createHash('sha256').update(`legacy-opaque-v1\0${prefix}`).digest('hex');
      await new PostgresLegacyOpaqueRetirementAudit(database).prepare({
        namespaceHash: legacyHash,
        cursorHash: 'b'.repeat(64),
        limit: 100,
      });
      await work.release(lease);
      lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      const replacement = await claim(lease);
      expect(replacement.stage).toBe(old.stage);
      expect(replacement.cursor).toEqual(old.cursor);
      expect(replacement.id).not.toBe(old.id);
      await expect(store.assertCurrent(lease, old.id)).rejects.toBeDefined();
      await store.complete(lease, replacement.id, empty(replacement));
      await finishPages(lease);
      await store.finish(lease);
      const facts = (
        await sql<{
          metadata: Record<string, unknown>;
        }>`SELECT metadata FROM platform.audit_logs WHERE event_type='account.deletion-ephemeral-reverified.v1' AND subject_id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows;
      expect(facts).toHaveLength(1);
      expect(facts[0]!.metadata.reverifiedIntentCount).toBe(8);
      expect(facts[0]!.metadata).not.toHaveProperty('removed');
    });
    it.each(['prefix', 'evidence'] as const)(
      'rejects changed deployment %s even for unobserved original intent',
      async (field) => {
        const lease = await scene();
        await claim(lease);
        const other = new PostgresAccountDeletionEphemeralStore(
          database,
          field === 'prefix' ? 'another-prefix' : prefix,
          field === 'evidence' ? 'b'.repeat(64) : evidence,
        );
        await expect(other.claimNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      },
    );
    it('rejects a cursor for a different physical namespace', async () => {
      const lease = await scene();
      for (let n = 0; n < 4; n++) {
        const op = await claim(lease);
        await store.complete(lease, op.id, empty(op));
      }
      const op = await claim(lease);
      await expect(
        store.complete(lease, op.id, {
          cursor: { redisCursor: '0', pendingKeys: [`other-prefix:domain-events:${randomUUID()}`] },
          more: true,
          found: 0,
        }),
      ).rejects.toBeDefined();
    });
    it.each(['prepared', 'observed', 'page'] as const)(
      'rolls back suppressed required %s and resumes safely',
      async (kind) => {
        let lease = await scene();
        const op = kind === 'prepared' ? undefined : await claim(lease);
        const table =
          kind === 'page' ? 'identity.account_deletion_ephemeral_pages' : 'platform.audit_logs';
        const predicate =
          kind === 'page' ? 'true' : `NEW.event_type='account.deletion-ephemeral-${kind}.v1'`;
        await sql
          .raw(
            `CREATE FUNCTION public.suppress_ephemeral() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
          )
          .execute(database);
        await sql
          .raw(
            `CREATE TRIGGER zz_suppress_ephemeral BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.suppress_ephemeral()`,
          )
          .execute(database);
        try {
          if (op) await expect(store.complete(lease, op.id, empty(op))).rejects.toBeDefined();
          else await expect(store.claimNext(lease)).rejects.toBeDefined();
        } finally {
          await sql.raw(`DROP TRIGGER zz_suppress_ephemeral ON ${table}`).execute(database);
          await sql`DROP FUNCTION public.suppress_ephemeral()`.execute(database);
        }
        await work.release(lease);
        lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
        await finishPages(lease);
        expect(await store.finish(lease)).toEqual({ completed: true });
      },
    );
    it.each(['reconciliation', 'audit', 'event', 'receipt', 'root', 'work'] as const)(
      'rolls back suppressed checkpoint %s and retries the same verified state',
      async (kind) => {
        const lease = await scene();
        await finishPages(lease);
        const table = {
          reconciliation: 'platform.audit_logs',
          audit: 'platform.audit_logs',
          event: 'platform.outbox_events',
          receipt: 'identity.account_deletion_phase_receipts',
          root: 'identity.account_deletion_records',
          work: 'identity.account_deletion_work',
        }[kind];
        const predicate =
          kind === 'reconciliation'
            ? "NEW.event_type='account.deletion-ephemeral-reverified.v1'"
            : kind === 'audit'
              ? "NEW.event_type='account.deletion-phase-completed.v1'"
              : 'true';
        await sql
          .raw(
            `CREATE FUNCTION public.suppress_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
          )
          .execute(database);
        await sql
          .raw(
            `CREATE TRIGGER zz_suppress_checkpoint BEFORE ${kind === 'root' || kind === 'work' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.suppress_checkpoint()`,
          )
          .execute(database);
        try {
          await expect(store.finish(lease)).rejects.toBeDefined();
        } finally {
          await sql.raw(`DROP TRIGGER zz_suppress_checkpoint ON ${table}`).execute(database);
          await sql`DROP FUNCTION public.suppress_checkpoint()`.execute(database);
        }
        expect(await store.finish(lease)).toEqual({ completed: true });
      },
    );
    it('captures an observation before asynchronous waits rather than auditing later caller mutations', async () => {
      const lease = await scene(),
        op = await claim(lease);
      const observation = { cursor: '0', more: false, found: 0 };
      const pending = store.complete(lease, op.id, observation);
      observation.cursor = '42';
      observation.more = true;
      observation.found = 100;
      await pending;
      expect(
        (
          await sql`SELECT cursor_out,more,found FROM identity.account_deletion_ephemeral_pages WHERE id=${op.id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ cursor_out: '0', more: false, found: 0 }]);
    });
    it('rolls back proof when a real native lease expires during deferred commit validation', async () => {
      let lease = await scene();
      await sql`CREATE SEQUENCE public.ephemeral_expiry_probe`.execute(database);
      await sql`CREATE FUNCTION public.delay_ephemeral_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('public.ephemeral_expiry_probe'); PERFORM pg_sleep(1.1); RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE CONSTRAINT TRIGGER aa_ephemeral_expiry AFTER INSERT ON identity.account_deletion_ephemeral_pages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.delay_ephemeral_proof()`.execute(
        database,
      );
      await work.release(lease);
      lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 1000 }))[0]!;
      const op = await claim(lease);
      try {
        await expect(store.complete(lease, op.id, empty(op))).rejects.toBeDefined();
        expect(
          (
            await sql<{
              is_called: boolean;
            }>`SELECT is_called FROM public.ephemeral_expiry_probe`.execute(database)
          ).rows[0]!.is_called,
        ).toBe(true);
      } finally {
        await sql`DROP TRIGGER aa_ephemeral_expiry ON identity.account_deletion_ephemeral_pages`.execute(
          database,
        );
        await sql`DROP FUNCTION public.delay_ephemeral_proof()`.execute(database);
        await sql`DROP SEQUENCE public.ephemeral_expiry_probe`.execute(database);
      }
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::integer AS count FROM identity.account_deletion_ephemeral_pages WHERE id=${op.id}::uuid`.execute(
            database,
          )
        ).rows[0]!.count,
      ).toBe(0);
      lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      await finishPages(lease);
      expect(await store.finish(lease)).toEqual({ completed: true });
    });
    it('rejects corrupted historical proof before provider work or checkpoint', async () => {
      const lease = await scene(),
        op = await claim(lease);
      await store.complete(lease, op.id, empty(op));
      await database.transaction().execute(async (tx) => {
        await sql`ALTER TABLE identity.account_deletion_ephemeral_pages DISABLE TRIGGER USER`.execute(
          tx,
        );
        try {
          await sql`UPDATE identity.account_deletion_ephemeral_pages SET found=1 WHERE id=${op.id}::uuid`.execute(
            tx,
          );
        } finally {
          await sql`ALTER TABLE identity.account_deletion_ephemeral_pages ENABLE TRIGGER USER`.execute(
            tx,
          );
        }
      });
      await expect(store.claimNext(lease)).rejects.toBeDefined();
      await expect(store.finish(lease)).rejects.toBeDefined();
    });
  },
);
