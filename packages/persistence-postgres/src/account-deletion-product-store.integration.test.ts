import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 bounded ordinary product batches', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionProductStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_product_batches');
    await runMigrations(isolated.url, resolve('migrations'));
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000096_m8_product_batches.sql',
    );
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionProductStore(database);
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
    const leases = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(leases).toHaveLength(1);
    return leases[0]!;
  }
  async function scene(
    before?: (userId: string) => Promise<void>,
    leaseMs = 120000,
  ): Promise<{ userId: string; recordId: string; lease: AccountDeletionLease }> {
    const fixture = await createDeletionFixture(database, before);
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(await claim());
    await checkpoints.finishEvidence(await claim());
    return { ...fixture, lease: await claim(leaseMs) };
  }
  async function facts(recordId: string): Promise<{
    audits: number;
    events: number;
    phase: string;
    product_purged_at: Date | null;
    completed_at: Date | null;
    reactivation_allowed: boolean;
  }> {
    return (
      await sql<{
        audits: number;
        events: number;
        phase: string;
        product_purged_at: Date | null;
        completed_at: Date | null;
        reactivation_allowed: boolean;
      }>`
      SELECT (SELECT count(*)::integer FROM platform.audit_logs WHERE subject_id=root.id
        AND event_type='account.deletion-product-batch.v1') AS audits,
        (SELECT count(*)::integer FROM platform.outbox_events WHERE aggregate_id=root.id
          AND event_type='account.deletion-product-batch.v1') AS events,
        phase,product_purged_at,completed_at,reactivation_allowed
      FROM identity.account_deletion_records root WHERE id=${recordId}::uuid`.execute(database)
    ).rows[0]!;
  }
  async function seedOwned(userId: string): Promise<void> {
    await sql`INSERT INTO identity.signup_drafts(user_id,draft_data,schema_version,created_at,updated_at)
      VALUES(${userId}::uuid,'{"name":"private purge fixture"}',1,clock_timestamp(),clock_timestamp())`.execute(
      database,
    );
    await sql`INSERT INTO identity.signup_progress(user_id,current_step,started_at,updated_at)
      VALUES(${userId}::uuid,'name',clock_timestamp(),clock_timestamp())`.execute(database);
    await database.transaction().execute(async (tx) => {
      await sql`INSERT INTO discovery.explore_filters(user_id,min_age,max_age,city_id,created_at,updated_at)
        VALUES(${userId}::uuid,18,60,'20000000-0000-4000-8000-000000000121',clock_timestamp(),clock_timestamp())`.execute(
        tx,
      );
      await sql`INSERT INTO discovery.explore_filter_genders(user_id,gender_option_id)
        SELECT ${userId}::uuid,id FROM catalog.gender_options WHERE is_active ORDER BY id LIMIT 2`.execute(
        tx,
      );
    });
  }
  async function ownedSnapshot(userId: string): Promise<unknown> {
    return (
      await sql<{ snapshot: unknown }>`SELECT jsonb_build_object(
      'draft',(SELECT to_jsonb(row) FROM identity.signup_drafts row WHERE user_id=${userId}::uuid),
      'progress',(SELECT to_jsonb(row) FROM identity.signup_progress row WHERE user_id=${userId}::uuid),
      'filter',(SELECT to_jsonb(row) FROM discovery.explore_filters row WHERE user_id=${userId}::uuid),
      'genders',(SELECT jsonb_agg(to_jsonb(row) ORDER BY gender_option_id) FROM discovery.explore_filter_genders row WHERE user_id=${userId}::uuid),
      'account',(SELECT to_jsonb(row) FROM identity.accounts row WHERE user_id=${userId}::uuid),
      'credits',(SELECT to_jsonb(row) FROM billing.credit_accounts row WHERE user_id=${userId}::uuid),
      'preview',(SELECT to_jsonb(row) FROM identity.guest_preview_counters row WHERE user_id=${userId}::uuid)) AS snapshot`.execute(
        database,
      )
    ).rows[0]!.snapshot;
  }
  it('purges every sweep resource in bounded batches, keeps counterpart data and never declares completion', async () => {
    const other = await createReportUser(database),
      spare = await createReportUser(database);
    await seedOwned(other);
    const item = await scene(async (userId) => {
      await seedOwned(userId);
      await sql`INSERT INTO discovery.candidate_deliveries(id,viewer_user_id,target_user_id,mode,filter_version,state,
        expires_at,reserved_at,failed_at,updated_at)
        SELECT gen_random_uuid(),CASE WHEN item=205 THEN ${other}::uuid ELSE ${userId}::uuid END,
          CASE WHEN item=205 THEN ${userId}::uuid ELSE ${other}::uuid END,'guest_preview',1,'failed',
          clock_timestamp()+interval '1 minute',clock_timestamp(),clock_timestamp(),clock_timestamp()
        FROM generate_series(1,205) item`.execute(database);
      await sql`INSERT INTO discovery.explore_consumptions(viewer_user_id,target_user_id,reason,consumed_at)
        VALUES(${userId}::uuid,${other}::uuid,'preview',clock_timestamp()),(${other}::uuid,${userId}::uuid,'preview',clock_timestamp()),
          (${other}::uuid,${spare}::uuid,'preview',clock_timestamp())`.execute(database);
      await sql`INSERT INTO interaction.not_interested(id,sender_user_id,receiver_user_id,source,created_at)
        VALUES(gen_random_uuid(),${userId}::uuid,${other}::uuid,'explore',clock_timestamp()),
          (gen_random_uuid(),${other}::uuid,${userId}::uuid,'explore',clock_timestamp()),
          (gen_random_uuid(),${other}::uuid,${spare}::uuid,'explore',clock_timestamp())`.execute(
        database,
      );
    });
    const counterpart = await ownedSnapshot(other),
      before = await ownedSnapshot(item.userId);
    const batches: number[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await store.purgeNext(item.lease);
      expect(result.purgedRows).toBeGreaterThan(0);
      expect(result.purgedRows).toBeLessThanOrEqual(100);
      batches.push(result.purgedRows);
      if (!result.hasMore) break;
    }
    expect(batches).toEqual([1, 1, 3, 100, 100, 5, 2, 2, 1, 1]);
    expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    expect(await ownedSnapshot(other)).toEqual(counterpart);
    const after = (await ownedSnapshot(item.userId)) as Record<string, unknown>;
    expect(after).toMatchObject({ draft: null, progress: null, filter: null, genders: null });
    for (const key of ['account', 'credits', 'preview'])
      expect(after[key]).toEqual((before as Record<string, unknown>)[key]);
    expect(await facts(item.recordId)).toEqual({
      audits: 10,
      events: 10,
      phase: 'product_data',
      product_purged_at: null,
      completed_at: null,
      reactivation_allowed: false,
    });
    expect(
      (
        await sql`SELECT 1 FROM discovery.explore_consumptions WHERE viewer_user_id=${other}::uuid AND target_user_id=${spare}::uuid`.execute(
          database,
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await sql`SELECT 1 FROM interaction.not_interested WHERE sender_user_id=${other}::uuid AND receiver_user_id=${spare}::uuid`.execute(
          database,
        )
      ).rows,
    ).toHaveLength(1);
    const audits = await database
      .selectFrom('platform.audit_logs')
      .select('metadata')
      .where('subject_id', '=', item.recordId)
      .where('event_type', '=', 'account.deletion-product-batch.v1')
      .execute();
    expect(JSON.stringify(audits)).not.toContain('private purge fixture');
    for (const audit of audits)
      expect(Object.keys(audit.metadata).sort()).toEqual([
        'eventId',
        'generation',
        'leaseExpiresAt',
        'owner',
        'resource',
        'rows',
      ]);
  });
  it('chunks large filter selections without violating their required-parent invariant', async () => {
    const extra = (
      await sql<{
        id: string;
      }>`INSERT INTO catalog.gender_options(id,code,label_key,is_active,display_order)
      SELECT gen_random_uuid(),'m8_batch_'||item,'fixture.m8.batch.gender_'||item,false,1000+item
      FROM generate_series(1,101) item RETURNING id`.execute(database)
    ).rows.map((row) => row.id);
    try {
      const item = await scene(async (userId) => {
        await seedOwned(userId);
        await database
          .insertInto('discovery.explore_filter_genders')
          .values(extra.map((id) => ({ user_id: userId, gender_option_id: id })))
          .execute();
      });
      expect((await store.purgeNext(item.lease)).purgedRows).toBe(1);
      expect((await store.purgeNext(item.lease)).purgedRows).toBe(1);
      expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 99, hasMore: true });
      expect(
        await database
          .selectFrom('discovery.explore_filters')
          .select('user_id')
          .where('user_id', '=', item.userId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('discovery.explore_filter_genders')
          .select('gender_option_id')
          .where('user_id', '=', item.userId)
          .execute(),
      ).toHaveLength(4);
      expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 5, hasMore: true });
      expect(
        await database
          .selectFrom('discovery.explore_filters')
          .select('user_id')
          .where('user_id', '=', item.userId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('discovery.explore_filter_genders')
          .select('gender_option_id')
          .where('user_id', '=', item.userId)
          .execute(),
      ).toHaveLength(0);
      expect(await facts(item.recordId)).toMatchObject({
        audits: 4,
        events: 4,
        phase: 'product_data',
        product_purged_at: null,
      });
    } finally {
      await database.deleteFrom('catalog.gender_options').where('id', 'in', extra).execute();
    }
  });
  it('twenty competing requests remove each row once and empty retries create no audit or event', async () => {
    const item = await scene();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
    );
    expect(results.reduce((total, result) => total + result.purgedRows, 0)).toBe(2);
    expect(results.filter((result) => result.purgedRows > 0)).toHaveLength(2);
    expect(await facts(item.recordId)).toMatchObject({
      audits: 2,
      events: 2,
      phase: 'product_data',
      completed_at: null,
    });
    expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
  });
  it('denies forged subject, owner, generation and phase before changing any product row', async () => {
    const item = await scene();
    for (const changed of [
      { userId: randomUUID() },
      { leaseOwner: randomUUID() },
      { leaseGeneration: item.lease.leaseGeneration + 1 },
      { phase: 'evidence_capture' as const, checkpointVersion: 2 },
      { checkpointVersion: 4 },
    ]) {
      await expect(store.purgeNext({ ...item.lease, ...changed })).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
    expect(
      await database
        .selectFrom('identity.user_settings')
        .select('user_id')
        .where('user_id', '=', item.userId)
        .execute(),
    ).toHaveLength(1);
  });
  it.each(['audit', 'event'] as const)(
    'rolls back deletion when the required %s write is suppressed',
    async (kind) => {
      const item = await scene();
      const table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
      await sql`CREATE FUNCTION public.m8_product_suppress() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='account.deletion-product-batch.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER m8_product_suppress BEFORE INSERT ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION public.m8_product_suppress()`.execute(
        database,
      );
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
      } finally {
        await sql`DROP TRIGGER m8_product_suppress ON ${sql.table(table)}`.execute(database);
        await sql`DROP FUNCTION public.m8_product_suppress()`.execute(database);
      }
      expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: true });
    },
  );
  it.each(['audit', 'event'] as const)(
    'rejects a required %s whose event type was changed',
    async (kind) => {
      const item = await scene();
      const table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
      await sql`CREATE FUNCTION public.m8_product_retype() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='account.deletion-product-batch.v1' THEN NEW.event_type='fixture.changed.v1'; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER m8_product_retype BEFORE INSERT ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION public.m8_product_retype()`.execute(
        database,
      );
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
      } finally {
        await sql`DROP TRIGGER m8_product_retype ON ${sql.table(table)}`.execute(database);
        await sql`DROP FUNCTION public.m8_product_retype()`.execute(database);
      }
      expect((await store.purgeNext(item.lease)).purgedRows).toBe(1);
    },
  );
  it('requires the exact audit/event chain at commit and rolls back tampered event payload', async () => {
    const item = await scene();
    await sql`CREATE FUNCTION public.m8_product_tamper() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='account.deletion-product-batch.v1' THEN NEW.payload=NEW.payload||'{"resource":7}'::jsonb; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_product_tamper BEFORE INSERT ON platform.outbox_events FOR EACH ROW EXECUTE FUNCTION public.m8_product_tamper()`.execute(
      database,
    );
    try {
      await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
    } finally {
      await sql`DROP TRIGGER m8_product_tamper ON platform.outbox_events`.execute(database);
      await sql`DROP FUNCTION public.m8_product_tamper()`.execute(database);
    }
    expect((await store.purgeNext(item.lease)).purgedRows).toBe(1);
  });
  it.each(['delete', 'commit'] as const)(
    'rolls back expiry during %s and resumes only under a new generation',
    async (boundary) => {
      const item = await scene(undefined, 1000);
      const table =
        boundary === 'delete' ? 'notification.notification_preferences' : 'platform.audit_logs';
      await sql
        .raw(
          `CREATE FUNCTION public.m8_product_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${boundary === 'commit' ? "IF NEW.event_type<>'account.deletion-product-batch.v1' THEN RETURN NULL; END IF;" : ''}
      PERFORM pg_sleep(1.15); RETURN ${boundary === 'delete' ? 'OLD' : 'NULL'}; END $$`,
        )
        .execute(database);
      if (boundary === 'delete')
        await sql`CREATE TRIGGER aaa_m8_product_pause BEFORE DELETE ON notification.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.m8_product_pause()`.execute(
          database,
        );
      else
        await sql`CREATE CONSTRAINT TRIGGER aaa_m8_product_pause AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.m8_product_pause()`.execute(
          database,
        );
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
      } finally {
        await sql`DROP TRIGGER aaa_m8_product_pause ON ${sql.table(table)}`.execute(database);
        await sql`DROP FUNCTION public.m8_product_pause()`.execute(database);
      }
      const next = await claim();
      expect(next.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
      await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect((await store.purgeNext(next)).purgedRows).toBe(1);
    },
  );
  it('checks the database clock again after waiting behind the owning Account', async () => {
    const item = await scene(undefined, 1000);
    let waiting: Promise<unknown>;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT user_id FROM identity.accounts WHERE user_id=${item.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      waiting = store.purgeNext(item.lease).then(
        () => 'unexpected_success',
        (error: unknown) => error,
      );
      await sql`SELECT pg_sleep(1.15)`.execute(tx);
    });
    expect(await waiting!).toMatchObject({ code: 'conflict' });
    expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
    expect((await store.purgeNext(await claim())).purgedRows).toBe(1);
  });
  it('rejects unreviewed schema drift before removing any row', async () => {
    const item = await scene();
    await sql`ALTER TABLE identity.signup_drafts ADD COLUMN unreviewed_product_field text`.execute(
      database,
    );
    try {
      await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await facts(item.recordId)).toMatchObject({ audits: 0, events: 0 });
    } finally {
      await sql`ALTER TABLE identity.signup_drafts DROP COLUMN unreviewed_product_field`.execute(
        database,
      );
    }
    expect((await store.purgeNext(item.lease)).purgedRows).toBe(1);
  });
  it('resumes after transport loss and lease release without repeating a committed batch', async () => {
    const item = await scene(seedOwned);
    expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: true });
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', item.recordId)
      .execute();
    await work.release(item.lease);
    const next = await claim();
    await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.purgeNext(next)).toEqual({ purgedRows: 1, hasMore: true });
    expect(await facts(item.recordId)).toMatchObject({
      audits: 2,
      events: 1,
      phase: 'product_data',
    });
  });
});
