import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountDeletionLease,
  AdminCommandAttempt,
  UserSupportWrite,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportFixtureAdmin, createReportUser } from './testing/report-fixture.js';
import { PostgresSupportStore } from './support-store.js';
import { PostgresSupportThreadRevealStore } from './support-reveal-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSupportStore } from './account-deletion-support-store.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  migration = '000102_m8_support_epoch_closure.sql';
function write(userId: string): UserSupportWrite {
  const commandId = randomUUID();
  return {
    userId,
    supportThreadId: randomUUID(),
    messageId: randomUUID(),
    eventId: randomUUID(),
    commandId,
    requestId: randomUUID(),
    idempotencyKey: `m8-support-${commandId}`,
    requestDigest: createHash('sha256').update(commandId).digest('hex'),
    normalizedText: 'Original retained support content',
  };
}
describe.skipIf(url === undefined)(
  'M8 original support lifecycle and retained scope closure',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let work: PostgresAccountDeletionWorkStore, closures: PostgresAccountDeletionSupportStore;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_support_closure');
      await runMigrations(isolated.url, resolve('migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 10000,
      });
      work = new PostgresAccountDeletionWorkStore(database);
      closures = new PostgresAccountDeletionSupportStore(database);
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
    async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
      const leases = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
      expect(leases).toHaveLength(1);
      return leases[0]!;
    }
    async function scene(leaseMs = 120000): Promise<{
      userId: string;
      recordId: string;
      lease: AccountDeletionLease;
      writes: UserSupportWrite[];
    }> {
      const writes: UserSupportWrite[] = [];
      const item = await createDeletionFixture(database, async (userId) => {
        for (let count = 0; count < 2; count++) {
          const item = write(userId);
          writes.push(item);
          await new PostgresSupportStore(database).open(item);
        }
      });
      const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
      await checkpoints.finishShared(await claim());
      await checkpoints.finishEvidence(await claim());
      return { ...item, lease: await claim(leaseMs), writes };
    }
    async function snapshot(userId: string): Promise<unknown> {
      return (
        await sql<{ value: unknown }>`SELECT jsonb_build_object(
      'threads',(SELECT jsonb_agg(to_jsonb(thread) ORDER BY id) FROM support.support_threads thread WHERE user_id=${userId}::uuid),
      'messages',(SELECT jsonb_agg(to_jsonb(message) ORDER BY message.id) FROM support.support_messages message JOIN support.support_threads thread ON thread.id=message.support_thread_id WHERE thread.user_id=${userId}::uuid),
      'closures',(SELECT jsonb_agg(to_jsonb(receipt) ORDER BY support_thread_id) FROM support.deletion_thread_closures receipt WHERE user_id=${userId}::uuid)) AS value`.execute(
          database,
        )
      ).rows[0]!.value;
    }
    async function messages(userId: string): Promise<unknown> {
      return (
        await sql<{
          value: unknown;
        }>`SELECT jsonb_agg(to_jsonb(message) ORDER BY message.id) AS value FROM support.support_messages message
      JOIN support.support_threads thread ON thread.id=message.support_thread_id WHERE thread.user_id=${userId}::uuid`.execute(
          database,
        )
      ).rows[0]!.value;
    }
    it('twenty retries close two original scopes once, preserve every message and remain valid after transport expiry and a new lease', async () => {
      const item = await scene(),
        before = await messages(item.userId);
      const owner = await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', item.userId)
        .executeTakeFirstOrThrow();
      const sources = await database
        .selectFrom('support.support_threads')
        .selectAll()
        .where('user_id', '=', item.userId)
        .orderBy('id')
        .execute();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => closures.closeNext(item.lease)),
      );
      expect(results.filter((result) => result.closed)).toHaveLength(2);
      expect(results.filter((result) => result.closed && result.hasMore)).toHaveLength(1);
      expect(await messages(item.userId)).toEqual(before);
      const receipts = await database
        .selectFrom('support.deletion_thread_closures')
        .selectAll()
        .where('user_id', '=', item.userId)
        .execute();
      expect(receipts).toHaveLength(2);
      for (const source of sources) {
        const receipt = receipts.find((row) => row.support_thread_id === source.id)!;
        expect(receipt.source_version).toBe(source.version);
        expect(receipt.product_epoch).toBe(0);
        expect(
          await database
            .selectFrom('support.support_threads')
            .selectAll()
            .where('id', '=', source.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          ...source,
          status: 'closed',
          version: source.version + 1,
          closed_at: receipt.closed_at,
        });
      }
      const flags = await sql<{
        id: string;
        withinLimit: boolean;
        hasAttempts: boolean;
      }>`SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.support_threads}) observed
      WHERE observed.id=ANY(${sources.map((row) => row.id)}::uuid[])`.execute(database);
      expect(flags.rows).toHaveLength(2);
      for (const flag of flags.rows)
        expect(flag).toMatchObject({ withinLimit: true, hasAttempts: true });
      expect(
        await database
          .selectFrom('identity.accounts')
          .selectAll()
          .where('user_id', '=', item.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(owner);
      expect(
        (
          await sql<{
            phase: string;
            checkpoint_version: number;
            product_purged_at: Date | null;
            completed_at: Date | null;
            reactivation_allowed: boolean;
          }>`
        SELECT phase,checkpoint_version,product_purged_at,completed_at,reactivation_allowed
        FROM identity.account_deletion_records WHERE id=${item.recordId}::uuid`.execute(database)
        ).rows[0],
      ).toEqual({
        phase: 'product_data',
        checkpoint_version: 3,
        product_purged_at: null,
        completed_at: null,
        reactivation_allowed: false,
      });
      await sql`DELETE FROM platform.outbox_events WHERE id=ANY(${receipts.map((row) => row.event_id)}::uuid[])`.execute(
        database,
      );
      await work.release(item.lease);
      const next = await claim();
      expect(next.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
      await expect(closures.closeNext(next)).resolves.toEqual({ closed: false, hasMore: false });
      await expect(closures.closeNext(item.lease)).rejects.toMatchObject({ status: 409 });
      for (const receipt of receipts)
        expect(
          (
            await sql<{
              valid: boolean;
            }>`SELECT support.deletion_thread_has_bound_closure(${receipt.support_thread_id}::uuid,${receipt.source_version}) AS valid`.execute(
              database,
            )
          ).rows[0]!.valid,
        ).toBe(true);
    });
    it('rejects wrong original owner, phase, worker and generation without changing retained content', async () => {
      const item = await scene(),
        before = await snapshot(item.userId);
      for (const lease of [
        { ...item.lease, userId: randomUUID() },
        { ...item.lease, phase: 'evidence_capture' as const, checkpointVersion: 2 },
        { ...item.lease, leaseOwner: randomUUID() },
        { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
      ])
        await expect(closures.closeNext(lease)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot(item.userId)).toEqual(before);
    });
    it('keeps closure/history immutable, denies old user replay and late native messages, and leaves counterpart support alone', async () => {
      const other = await createReportUser(database),
        otherWrite = write(other);
      await new PostgresSupportStore(database).open(otherWrite);
      const otherBefore = await snapshot(other),
        item = await scene();
      await closures.closeNext(item.lease);
      await closures.closeNext(item.lease);
      const before = await snapshot(item.userId);
      const thread = item.writes[0]!.supportThreadId;
      await expect(new PostgresSupportStore(database).open(item.writes[0]!)).rejects.toMatchObject({
        status: 409,
      });
      for (const operation of [
        sql`UPDATE support.support_threads SET product_epoch=1 WHERE id=${thread}::uuid`,
        sql`DELETE FROM support.support_threads WHERE id=${thread}::uuid`,
        sql`UPDATE support.deletion_thread_closures SET source_version=source_version+1 WHERE support_thread_id=${thread}::uuid`,
        sql`DELETE FROM support.deletion_thread_closures WHERE support_thread_id=${thread}::uuid`,
        sql`UPDATE support.support_messages SET message_text='changed' WHERE support_thread_id=${thread}::uuid`,
      ])
        await expect(operation.execute(database)).rejects.toMatchObject({ code: '55000' });
      const original = await database
        .selectFrom('support.support_messages')
        .selectAll()
        .where('support_thread_id', '=', thread)
        .executeTakeFirstOrThrow();
      await expect(
        database
          .insertInto('support.support_messages')
          .values({
            ...original,
            id: randomUUID(),
            command_id: randomUUID(),
            idempotency_key: randomUUID(),
          })
          .execute(),
      ).rejects.toMatchObject({ code: '40001' });
      expect(await snapshot(item.userId)).toEqual(before);
      expect(await snapshot(other)).toEqual(otherBefore);
    });
    it.each(['audit', 'event'] as const)(
      'rolls back closure and every retained field when required %s is absent',
      async (kind) => {
        const item = await scene(),
          before = await snapshot(item.userId),
          table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
        await sql`CREATE FUNCTION public.m8_drop_support_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='account.deletion-support-closed.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
          database,
        );
        try {
          await sql`CREATE TRIGGER m8_drop_support_proof BEFORE INSERT ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION public.m8_drop_support_proof()`.execute(
            database,
          );
          await expect(closures.closeNext(item.lease)).rejects.toMatchObject({
            code: kind === 'audit' ? '23503' : '23514',
          });
          expect(await snapshot(item.userId)).toEqual(before);
        } finally {
          await sql`DROP TRIGGER m8_drop_support_proof ON ${sql.table(table)}`.execute(database);
          await sql`DROP FUNCTION public.m8_drop_support_proof()`.execute(database);
        }
        expect(await closures.closeNext(item.lease)).toMatchObject({ closed: true });
      },
    );
    it('rolls back at actual commit after the live lease expires and resumes under a new generation', async () => {
      const item = await scene(1000),
        before = await snapshot(item.userId);
      await sql`CREATE FUNCTION public.m8_pause_support_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='account.deletion-support-closed.v1' THEN PERFORM pg_sleep(1.2); END IF; RETURN NULL; END $$`.execute(
        database,
      );
      try {
        await sql`CREATE CONSTRAINT TRIGGER m8_pause_support_commit AFTER INSERT ON platform.audit_logs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.m8_pause_support_commit()`.execute(
          database,
        );
        await expect(closures.closeNext(item.lease)).rejects.toMatchObject({ code: '23514' });
        expect(await snapshot(item.userId)).toEqual(before);
      } finally {
        await sql`DROP TRIGGER m8_pause_support_commit ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION public.m8_pause_support_commit()`.execute(database);
      }
      const next = await claim();
      expect(next.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
      expect(await closures.closeNext(next)).toMatchObject({ closed: true });
      await expect(closures.closeNext(item.lease)).rejects.toMatchObject({ status: 409 });
    });
    it('reports a corrupted closure audit as missing authority and restores only the isolated diagnostic row', async () => {
      const item = await scene();
      await closures.closeNext(item.lease);
      const receipt = await database
        .selectFrom('support.deletion_thread_closures')
        .selectAll()
        .where('deletion_record_id', '=', item.recordId)
        .executeTakeFirstOrThrow();
      const audit = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('id', '=', receipt.audit_id)
        .executeTakeFirstOrThrow();
      async function flag(): Promise<boolean> {
        return (
          await sql<{
            hasAttempts: boolean;
          }>`SELECT observed."hasAttempts" FROM (${MODERATION_INTEGRITY_SOURCES.support_threads}) observed
      WHERE observed.id=${receipt.support_thread_id}::uuid`.execute(database)
        ).rows[0]!.hasAttempts;
      }
      expect(await flag()).toBe(true);
      async function set(metadata: Readonly<Record<string, unknown>>): Promise<void> {
        // Deliberate corruption of this test-owned database, never a successful
        // lifecycle/return fixture or a production guard exception.
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await connection
              .updateTable('platform.audit_logs')
              .set({ metadata })
              .where('id', '=', audit.id)
              .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      try {
        await set({ kind: 'support_scope', count: 2 });
        expect(await flag()).toBe(false);
      } finally {
        await set(audit.metadata);
      }
      expect(await flag()).toBe(true);
    });
    it('retains the existing separately audited administrator content-read capability after scope closure', async () => {
      const item = await scene();
      await closures.closeNext(item.lease);
      await closures.closeNext(item.lease);
      const admin = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: admin,
          role_code: 'support',
          assigned_by_admin_id: admin,
          revoked_at: null,
          revoked_by_admin_id: null,
        })
        .execute();
      const commandId = randomUUID(),
        thread = item.writes[0]!.supportThreadId;
      const attempt: AdminCommandAttempt = {
        logId: randomUUID(),
        adminUserId: admin,
        commandId,
        requestId: randomUUID(),
        requestDigest: createHash('sha256').update(commandId).digest('hex'),
        commandCode: 'support.reveal-thread',
        requiredPermission: 'review_support',
        targetType: 'support_thread',
        targetId: thread,
        expectedTargetVersion: 2,
        reasonDigest: createHash('sha256').update('review').digest('hex'),
        metadata: {},
        correlationId: randomUUID(),
      };
      const result = await new PostgresSupportThreadRevealStore(database).reveal(attempt);
      expect(result.result).toBe('succeeded');
      expect(result.value).toMatchObject({
        status: 'closed',
        threadVersion: 2,
        messages: [{ senderType: 'user', text: item.writes[0]!.normalizedText }],
      });
      expect(
        await database
          .selectFrom('administration.safety_access_audits')
          .select(['outcome', 'item_count'])
          .where('command_id', '=', commandId)
          .execute(),
      ).toEqual([{ outcome: 'revealed', item_count: 1 }]);
    });
    it('upgrades a populated original support life twenty ways without rewriting any prior field or message', async () => {
      const old = await createIsolatedTestDatabase(url!, 'm8_support_upgrade'),
        directory = await mkdtemp(join(tmpdir(), 'm8-support101-'));
      const legacy = createDatabase({
        url: old.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 10000,
      });
      try {
        for (const file of await readdir(resolve('migrations')))
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 101)
            await copyFile(join(resolve('migrations'), file), join(directory, file));
        await runMigrations(old.url, directory);
        const user = await createReportUser(legacy),
          item = write(user);
        // Write the original migration-101 shape; the current adapter deliberately
        // requires the new epoch column and cannot run before that upgrade.
        await legacy.transaction().execute(async (tx) => {
          const at = new Date();
          await tx
            .insertInto('support.support_threads')
            .values({
              id: item.supportThreadId,
              user_id: user,
              status: 'open',
              open_command_id: item.commandId,
              open_idempotency_key: item.idempotencyKey,
              open_request_digest: item.requestDigest,
              last_message_at: at,
              created_at: at,
              closed_at: null,
              version: 1,
            })
            .execute();
          await tx
            .insertInto('support.support_messages')
            .values({
              id: item.messageId,
              support_thread_id: item.supportThreadId,
              sender_type: 'user',
              sender_user_id: user,
              sender_admin_id: null,
              message_text: item.normalizedText,
              command_id: item.commandId,
              request_id: item.requestId,
              request_digest: item.requestDigest,
              idempotency_key: item.idempotencyKey,
              thread_version_after: 1,
              unanswered_user_messages_after: 1,
              created_at: at,
            })
            .execute();
        });
        const source = await legacy
          .selectFrom('support.support_threads')
          .selectAll()
          .where('id', '=', item.supportThreadId)
          .executeTakeFirstOrThrow();
        const messages = await legacy
          .selectFrom('support.support_messages')
          .selectAll()
          .where('support_thread_id', '=', item.supportThreadId)
          .execute();
        const upgraded = await Promise.all(
          Array.from({ length: 20 }, () => runMigrations(old.url, resolve('migrations'))),
        );
        expect(upgraded.flatMap((row) => row.applied)).toEqual([migration]);
        expect(
          await legacy
            .selectFrom('support.support_threads')
            .selectAll()
            .where('id', '=', item.supportThreadId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ ...source, product_epoch: 0 });
        expect(
          await legacy
            .selectFrom('support.support_messages')
            .selectAll()
            .where('support_thread_id', '=', item.supportThreadId)
            .execute(),
        ).toEqual(messages);
        expect(await verifyMigrations(old.url, resolve('migrations/verify'))).toContain(migration);
        expect((await runMigrations(old.url, resolve('migrations'))).applied).toEqual([]);
      } finally {
        await legacy.destroy();
        await old.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
