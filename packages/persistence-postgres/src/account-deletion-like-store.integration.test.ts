import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportLike, createReportMatch, createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionLikeStore } from './account-deletion-like-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 bounded original-life unreferenced Like purge', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionLikeStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_like_purge');
    await runMigrations(isolated.url, resolve('migrations'));
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000108_m8_unreferenced_like_purge.sql',
    );
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionLikeStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const result = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(result).toHaveLength(1);
    return result[0]!;
  }
  async function pair(first: string, second: string): Promise<string[]> {
    const ids = [
      await createReportLike(database, first, second),
      await createReportLike(database, second, first),
    ];
    await database
      .updateTable('interaction.likes')
      .set({ status: 'closed_by_not_interested', closed_at: new Date(), version: 2 })
      .where('id', 'in', ids)
      .execute();
    return ids;
  }
  async function scene(
    before?: (userId: string) => Promise<void>,
    leaseMs = 120000,
  ): Promise<AccountDeletionLease> {
    const item = await createDeletionFixture(database, before);
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(await claim());
    await checkpoints.finishEvidence(await claim());
    const lease = await claim(leaseMs);
    expect(lease.deletionRecordId).toBe(item.recordId);
    return lease;
  }
  async function facts(lease: AccountDeletionLease): Promise<unknown> {
    return (
      await sql<{ facts: unknown }>`SELECT jsonb_build_object(
      'likes',(SELECT jsonb_agg(to_jsonb(source) ORDER BY id) FROM interaction.likes source WHERE ${lease.userId}::uuid IN (sender_user_id,receiver_user_id)),
      'account',(SELECT to_jsonb(source) FROM identity.accounts source WHERE user_id=${lease.userId}::uuid),
      'root',(SELECT to_jsonb(source) FROM identity.account_deletion_records source WHERE id=${lease.deletionRecordId}::uuid),
      'preview',(SELECT to_jsonb(source) FROM identity.guest_preview_counters source WHERE user_id=${lease.userId}::uuid),
      'credits',(SELECT jsonb_agg(to_jsonb(source) ORDER BY id) FROM billing.credit_transactions source),
      'anchors',(SELECT jsonb_agg(to_jsonb(source) ORDER BY id) FROM interaction.like_reference_anchors source),
      'audits',(SELECT count(*) FROM platform.audit_logs WHERE subject_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-product-batch.v1'),
      'events',(SELECT count(*) FROM platform.outbox_events WHERE aggregate_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-product-batch.v1')) AS facts`.execute(
        database,
      )
    ).rows[0]!.facts;
  }
  it('purges both directions once under twenty-way retries, preserves unrelated facts and permits transport-independent replay', async () => {
    const other = await createReportUser(database),
      spare = await createReportUser(database);
    const unrelated = await pair(other, spare);
    const unrelatedBefore = await database
      .selectFrom('interaction.likes')
      .selectAll()
      .where('id', 'in', unrelated)
      .execute();
    const lease = await scene(async (userId) => {
      await pair(userId, other);
    });
    const before = (await facts(lease)) as Record<string, unknown>;
    const results = await Promise.all(Array.from({ length: 20 }, () => store.purgeNext(lease)));
    expect(results.filter((result) => result.purgedRows > 0)).toHaveLength(1);
    expect(results.reduce((total, result) => total + result.purgedRows, 0)).toBe(2);
    const after = (await facts(lease)) as Record<string, unknown>;
    expect(after).toMatchObject({ likes: null, audits: 1, events: 1 });
    for (const key of ['account', 'root', 'preview', 'credits', 'anchors'])
      expect(after[key]).toEqual(before[key]);
    expect(
      await database
        .selectFrom('interaction.likes')
        .selectAll()
        .where('id', 'in', unrelated)
        .execute(),
    ).toEqual(unrelatedBefore);
    const audit = await database
      .selectFrom('platform.audit_logs')
      .select('metadata')
      .where('subject_id', '=', lease.deletionRecordId)
      .where('event_type', '=', 'account.deletion-product-batch.v1')
      .executeTakeFirstOrThrow();
    expect(Object.keys(audit.metadata).sort()).toEqual([
      'eventId',
      'generation',
      'leaseExpiresAt',
      'owner',
      'resource',
      'rows',
    ]);
    expect(audit.metadata).toMatchObject({ resource: 8, rows: 2 });
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', lease.deletionRecordId)
      .execute();
    await work.release(lease);
    await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.purgeNext(await claim())).toEqual({
      purgedRows: 0,
      hasMore: false,
      waitingForReferences: false,
    });
  });
  it('resumes one pair at a time and does not mistake a referenced archived Match source for purge completion', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database),
      retained = await createReportUser(database);
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: retained, created_at: new Date(), updated_at: new Date() })
      .execute();
    const item = await createDeletionFixture(database, async (userId) => {
      await pair(userId, first);
      await pair(userId, second);
      await createReportMatch(database, userId, retained);
    });
    const shared = await claim();
    const closure = new PostgresAccountDeletionSharedStore(database);
    while ((await closure.closeNext(shared)).hasMore) {
      /* bounded executor resumes */
    }
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    expect(
      await new PostgresAccountDeletionMatchStore(database).archiveNext(evidence),
    ).toMatchObject({ archived: true, hasMore: false });
    await checkpoints.finishEvidence(evidence);
    const lease = await claim();
    expect(lease.deletionRecordId).toBe(item.recordId);
    const original = (await facts(lease)) as Record<string, unknown>;
    expect(await store.purgeNext(lease)).toEqual({
      purgedRows: 2,
      hasMore: true,
      waitingForReferences: false,
    });
    expect(await store.purgeNext(lease)).toEqual({
      purgedRows: 2,
      hasMore: true,
      waitingForReferences: true,
    });
    expect(await store.purgeNext(lease)).toEqual({
      purgedRows: 0,
      hasMore: true,
      waitingForReferences: true,
    });
    const final = (await facts(lease)) as Record<string, unknown>;
    expect(final).toMatchObject({ audits: 2, events: 2 });
    expect(final.anchors).toEqual(original.anchors);
    expect(
      await database
        .selectFrom('interaction.likes')
        .select('id')
        .where('sender_user_id', 'in', [lease.userId, retained])
        .where('receiver_user_id', 'in', [lease.userId, retained])
        .execute(),
    ).toHaveLength(2);
    expect(final.root).toEqual(original.root);
  });
  it('denies forged root, subject, worker, generation and phase before changing source or evidence', async () => {
    const other = await createReportUser(database);
    const lease = await scene(async (userId) => {
      await pair(userId, other);
    });
    const original = await facts(lease);
    for (const changed of [
      { deletionRecordId: randomUUID() },
      { userId: other },
      { leaseOwner: randomUUID() },
      { leaseGeneration: lease.leaseGeneration + 1 },
      { phase: 'evidence_capture' as const, checkpointVersion: 2 },
    ]) {
      await expect(store.purgeNext({ ...lease, ...changed })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await facts(lease)).toEqual(original);
    }
  });
  it.each(['audit', 'event', 'source'] as const)(
    'rolls back missing required %s and allows the exact original retry',
    async (kind) => {
      const other = await createReportUser(database);
      const lease = await scene(async (userId) => {
        await pair(userId, other);
      });
      const original = await facts(lease);
      const table =
        kind === 'source'
          ? 'interaction.likes'
          : kind === 'audit'
            ? 'platform.audit_logs'
            : 'platform.outbox_events';
      await sql
        .raw(
          `CREATE FUNCTION public.m8_like_purge_suppress() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${kind === 'source' ? 'RETURN NULL;' : "IF NEW.event_type='account.deletion-product-batch.v1' THEN RETURN NULL; END IF; RETURN NEW;"} END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER m8_like_purge_suppress BEFORE ${kind === 'source' ? 'DELETE' : 'INSERT'} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION public.m8_like_purge_suppress()`,
        )
        .execute(database);
      try {
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(lease)).toEqual(original);
      } finally {
        await sql.raw(`DROP TRIGGER m8_like_purge_suppress ON ${table}`).execute(database);
        await sql`DROP FUNCTION public.m8_like_purge_suppress()`.execute(database);
      }
      expect(await store.purgeNext(lease)).toEqual({
        purgedRows: 2,
        hasMore: false,
        waitingForReferences: false,
      });
    },
  );
  it('requires exact original owning life without accepting a borrowed later epoch', async () => {
    const other = await createReportUser(database);
    const lease = await scene(async (userId) => {
      await pair(userId, other);
    });
    const original = await facts(lease);
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role=replica`.execute(connection);
      try {
        await sql`UPDATE identity.accounts SET product_epoch=1 WHERE user_id=${lease.userId}::uuid`.execute(
          connection,
        );
      } finally {
        await sql`SET session_replication_role=origin`.execute(connection);
      }
    });
    try {
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      const corrupted = (await facts(lease)) as Record<string, unknown>;
      const prior = original as Record<string, unknown>;
      for (const key of ['likes', 'root', 'anchors', 'credits', 'audits', 'events'])
        expect(corrupted[key]).toEqual(prior[key]);
    } finally {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE identity.accounts SET product_epoch=0 WHERE user_id=${lease.userId}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    }
    expect(await facts(lease)).toEqual(original);
    expect((await store.purgeNext(lease)).purgedRows).toBe(2);
  });
  it('rechecks the actual clock after an owning Account lock wait', async () => {
    const other = await createReportUser(database);
    const lease = await scene(async (userId) => {
      await pair(userId, other);
    }, 1000);
    const original = await facts(lease);
    let waiting: Promise<unknown>;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT user_id FROM identity.accounts WHERE user_id=${lease.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      waiting = store.purgeNext(lease).then(
        () => 'unexpected_success',
        (error: unknown) => error,
      );
      await sql`SELECT pg_sleep(1.15)`.execute(tx);
    });
    expect(await waiting!).toMatchObject({ code: 'conflict' });
    expect(await facts(lease)).toEqual(original);
    expect((await store.purgeNext(await claim())).purgedRows).toBe(2);
  });
  it.each(['audit', 'event'] as const)(
    'rejects a required %s retyped before insertion',
    async (kind) => {
      const other = await createReportUser(database);
      const lease = await scene(async (userId) => {
        await pair(userId, other);
      });
      const original = await facts(lease);
      const table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
      await sql`CREATE FUNCTION public.m8_like_purge_retype() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='account.deletion-product-batch.v1' THEN NEW.event_type='fixture.changed.v1'; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql
        .raw(
          `CREATE TRIGGER m8_like_purge_retype BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.m8_like_purge_retype()`,
        )
        .execute(database);
      try {
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(lease)).toEqual(original);
      } finally {
        await sql.raw(`DROP TRIGGER m8_like_purge_retype ON ${table}`).execute(database);
        await sql`DROP FUNCTION public.m8_like_purge_retype()`.execute(database);
      }
      expect((await store.purgeNext(lease)).purgedRows).toBe(2);
    },
  );
  it('requires the exact resource and row count in the event at deferred commit', async () => {
    const other = await createReportUser(database);
    const lease = await scene(async (userId) => {
      await pair(userId, other);
    });
    const original = await facts(lease);
    await expect(
      database.transaction().execute(async (tx) => {
        const result = await sql<{
          purged_rows: number;
        }>`SELECT * FROM interaction.purge_deletion_unreferenced_likes(
        ${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(
          tx,
        );
        expect(result.rows[0]!.purged_rows).toBe(2);
        await sql`UPDATE platform.outbox_events SET payload=payload||'{"resource":7,"rows":1}'::jsonb
        WHERE aggregate_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-product-batch.v1'`.execute(
          tx,
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await facts(lease)).toEqual(original);
    expect((await store.purgeNext(lease)).purgedRows).toBe(2);
  });
  it('rejects a forged but mutually consistent audit/event count that differs from actual removal', async () => {
    const other = await createReportUser(database);
    const lease = await scene(async (userId) => {
      await pair(userId, other);
    });
    const original = await facts(lease);
    await sql`CREATE FUNCTION public.m8_like_purge_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='account.deletion-product-batch.v1' THEN
        IF TG_TABLE_NAME='audit_logs' THEN NEW.metadata=NEW.metadata||'{"rows":1}'::jsonb;
        ELSE NEW.payload=NEW.payload||'{"rows":1}'::jsonb; END IF;
      END IF; RETURN NEW; END $$`.execute(database);
    for (const table of ['platform.audit_logs', 'platform.outbox_events'])
      await sql
        .raw(
          `CREATE TRIGGER m8_like_purge_count BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.m8_like_purge_count()`,
        )
        .execute(database);
    try {
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await facts(lease)).toEqual(original);
    } finally {
      for (const table of ['platform.audit_logs', 'platform.outbox_events'])
        await sql.raw(`DROP TRIGGER m8_like_purge_count ON ${table}`).execute(database);
      await sql`DROP FUNCTION public.m8_like_purge_count()`.execute(database);
    }
    expect((await store.purgeNext(lease)).purgedRows).toBe(2);
  });
  it.each(['source', 'commit'] as const)(
    'rolls back lease expiry at %s and resumes only with a new generation',
    async (boundary) => {
      const other = await createReportUser(database);
      const lease = await scene(async (userId) => {
        await pair(userId, other);
      }, 1000);
      const original = await facts(lease);
      const table = boundary === 'source' ? 'interaction.likes' : 'platform.audit_logs';
      await sql
        .raw(
          `CREATE FUNCTION public.m8_like_purge_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${boundary === 'commit' ? "IF NEW.event_type<>'account.deletion-product-batch.v1' THEN RETURN NULL; END IF;" : ''}
      PERFORM pg_sleep(1.15); RETURN ${boundary === 'source' ? 'OLD' : 'NULL'}; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE ${boundary === 'commit' ? 'CONSTRAINT ' : ''}TRIGGER aaa_m8_like_purge_pause
      ${boundary === 'source' ? 'BEFORE DELETE' : 'AFTER INSERT'} ON ${table}
      ${boundary === 'commit' ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION public.m8_like_purge_pause()`,
        )
        .execute(database);
      try {
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(lease)).toEqual(original);
      } finally {
        await sql.raw(`DROP TRIGGER aaa_m8_like_purge_pause ON ${table}`).execute(database);
        await sql`DROP FUNCTION public.m8_like_purge_pause()`.execute(database);
      }
      const next = await claim();
      expect(next.leaseGeneration).toBe(lease.leaseGeneration + 1);
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      expect((await store.purgeNext(next)).purgedRows).toBe(2);
    },
  );
});
