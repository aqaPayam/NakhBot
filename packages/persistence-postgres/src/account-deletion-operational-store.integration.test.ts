import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
import { PostgresAccountDeletionOperationalStore } from './account-deletion-operational-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';
import { PostgresAccountDeletionTransportStore } from './account-deletion-transport-store.js';
import { PostgresAccountDeletionFinancialStore } from './account-deletion-financial-store.js';
import { PostgresOutboxStore } from './foundation-store.js';
import { DELETION_EVENT_POLICY } from './deletion-event-policy.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 owned operational cancellation', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionOperationalStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_ops_cancel');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionOperationalStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  async function event(owner: string, type: string, payload: object): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
      occurred_at,available_at,correlation_id,causation_id)
      VALUES(${id}::uuid,'user',${owner}::uuid,${type},1,${JSON.stringify(payload)}::jsonb,
        clock_timestamp(),clock_timestamp(),${randomUUID()}::uuid,${randomUUID()}::uuid)`.execute(
      database,
    );
    return id;
  }
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const claims = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(claims).toHaveLength(1);
    return claims[0]!;
  }
  async function scene(
    count = 1,
    leaseMs = 120000,
  ): Promise<{ lease: AccountDeletionLease; ids: string[]; otherId: string }> {
    const other = await createReportUser(database, true);
    const otherId = await event(other, 'profile.updated.v1', {
      userId: other,
      profileId: randomUUID(),
      version: 1,
    });
    const ids: string[] = [];
    const fixture = await createDeletionFixture(database, async (owner) => {
      // Synthetic metadata exercises cancellation only, never Profile admission.
      for (let index = 0; index < count; index++)
        ids.push(
          await event(owner, 'profile.updated.v1', {
            userId: owner,
            profileId: randomUUID(),
            version: 1,
          }),
        );
    });
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(await claim());
    await checkpoints.finishEvidence(await claim());
    const lease = await claim(leaseMs);
    expect(lease.deletionRecordId).toBe(fixture.recordId);
    return { lease, ids, otherId };
  }
  async function snapshot(id: string): Promise<unknown> {
    return (
      await sql`SELECT to_jsonb(event) AS facts FROM platform.outbox_events event WHERE id=${id}::uuid`.execute(
        database,
      )
    ).rows;
  }
  it('matches the reviewed native policy and exact complete catalog', async () => {
    expect(
      (
        await sql<{
          policy: typeof DELETION_EVENT_POLICY;
        }>`SELECT platform.deletion_event_policy() AS policy`.execute(database)
      ).rows[0]!.policy,
    ).toEqual(DELETION_EVENT_POLICY);
    const catalog = await readDeletionCatalog(database);
    expect(catalog.tables).toHaveLength(152);
    expect(catalog.tables.reduce((n, row) => n + row.columns.length, 0)).toBe(1399);
    expect(catalog.foreignKeys).toHaveLength(304);
    assertDeletionCatalogCoverage(catalog);
  });
  it('cancels 207 owned metadata events in bounded concurrent batches and preserves counterpart and retained channels', async () => {
    const item = await scene(205),
      before = await snapshot(item.otherId);
    const financial = await event(item.lease.userId, 'billing.payment-corrected.v1', {
      paymentRecordId: randomUUID(),
      refundRecordId: randomUUID(),
    });
    const safety = await event(item.lease.userId, 'moderation.report-submitted.v1', {
      reportId: randomUUID(),
      evidenceTypes: ['profile'],
      status: 'submitted',
    });
    const limited = await event(item.lease.userId, 'telegram.start-route-requested.v1', {
      userId: item.lease.userId,
      entryRoute: 'return_decision',
      uiLocale: 'en',
    });
    const retained = await Promise.all([financial, safety, limited].map(snapshot));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.cancelNext(item.lease)),
    );
    expect(results.reduce((n, row) => n + row.cancelledRows, 0)).toBe(207);
    expect(results.every((row) => row.cancelledRows <= 100 && row.blockedBy === null)).toBe(true);
    expect(await store.cancelNext(item.lease)).toEqual({
      cancelledRows: 0,
      hasMore: false,
      waitingForLease: false,
      blockedBy: null,
    });
    expect(await snapshot(item.otherId)).toEqual(before);
    expect(await Promise.all([financial, safety, limited].map(snapshot))).toEqual(retained);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM platform.outbox_events WHERE deletion_cancellation_audit_id IS NOT NULL`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 207 }]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE subject_id=${item.lease.deletionRecordId}::uuid AND event_type='account.deletion-operational-batch.v1'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    expect(
      (
        await sql`SELECT bool_and(platform.deletion_event_cancellation_valid(event)) AS valid FROM platform.outbox_events event WHERE deletion_cancellation_audit_id IS NOT NULL`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
    const publisher = new PostgresOutboxStore(database);
    const claims = await publisher.claimBatch({
      owner: 'ops-after-cancel',
      now: new Date(),
      leaseMs: 60000,
      limit: 100,
      eventTypes: [
        'profile.updated.v1',
        'billing.payment-corrected.v1',
        'moderation.report-submitted.v1',
        'telegram.start-route-requested.v1',
      ],
    });
    expect(claims.some((row) => item.ids.includes(row.id))).toBe(false);
    expect([financial, safety, limited].every((id) => claims.some((row) => row.id === id))).toBe(
      true,
    );
  });
  it('waits for a genuine publisher lease, resumes after release and denies the old acknowledgement', async () => {
    const item = await scene(),
      publisher = new PostgresOutboxStore(database),
      owner = randomUUID();
    const claims = await publisher.claimBatch({
      owner,
      now: new Date(),
      leaseMs: 60000,
      limit: 100,
      eventTypes: ['profile.updated.v1'],
    });
    expect(claims.some((row) => row.id === item.ids[0])).toBe(true);
    expect(await store.cancelNext(item.lease)).toMatchObject({
      hasMore: true,
      waitingForLease: true,
      blockedBy: null,
    });
    await publisher.release(item.ids[0]!, owner, 'test_retry', new Date());
    expect(await store.cancelNext(item.lease)).toMatchObject({ cancelledRows: 1, hasMore: false });
    const before = await snapshot(item.ids[0]!);
    await expect(publisher.markPublished(item.ids[0]!, owner, new Date())).rejects.toThrow(
      'Outbox lease was lost',
    );
    await publisher.release(item.ids[0]!, owner, 'test_retry', new Date());
    expect(await snapshot(item.ids[0]!)).toEqual(before);
  });
  it.each(['audit', 'source', 'event'] as const)(
    'rolls back a suppressed mandatory %s and resumes once',
    async (kind) => {
      const item = await scene(),
        before = await snapshot(item.ids[0]!);
      const table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
      const operation = kind === 'source' ? 'UPDATE' : 'INSERT';
      await sql
        .raw(
          `CREATE FUNCTION platform.ops_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER a_ops_suppress BEFORE ${operation} ON ${table} FOR EACH ROW
      WHEN (${kind === 'source' ? 'NEW.deletion_cancellation_audit_id IS NOT NULL' : "NEW.event_type='account.deletion-operational-batch.v1'"}) EXECUTE FUNCTION platform.ops_suppress()`,
        )
        .execute(database);
      try {
        await expect(store.cancelNext(item.lease)).rejects.toMatchObject({ status: 409 });
        expect(await snapshot(item.ids[0]!)).toEqual(before);
      } finally {
        await sql
          .raw(`DROP TRIGGER a_ops_suppress ON ${table}; DROP FUNCTION platform.ops_suppress()`)
          .execute(database);
      }
      expect(await store.cancelNext(item.lease)).toMatchObject({
        cancelledRows: 3,
        hasMore: false,
      });
    },
  );
  it('blocks unclassified content without changing or silently retaining it as financial proof', async () => {
    const item = await scene();
    const unknown = await event(item.lease.userId, 'billing.payment-fulfilled.v1', {
      paymentRecordId: randomUUID(),
      note: 'Private material',
    });
    const before = await snapshot(unknown);
    expect(await store.cancelNext(item.lease)).toMatchObject({
      cancelledRows: 0,
      blockedBy: 'unclassified',
    });
    expect(await snapshot(unknown)).toEqual(before);
    await sql`DELETE FROM platform.outbox_events WHERE id=${unknown}::uuid`.execute(database);
    expect(await store.cancelNext(item.lease)).toMatchObject({ cancelledRows: 3, hasMore: false });
  });
  it('rejects borrowed worker authority and direct cancellation reassignment', async () => {
    const item = await scene(),
      before = await snapshot(item.ids[0]!);
    for (const lease of [
      { ...item.lease, leaseOwner: randomUUID() },
      { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
    ])
      await expect(store.cancelNext(lease)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(item.ids[0]!)).toEqual(before);
    await expect(
      sql`UPDATE platform.outbox_events SET deletion_cancellation_audit_id=${randomUUID()}::uuid WHERE id=${item.ids[0]}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await store.cancelNext(item.lease);
    await expect(
      sql`UPDATE platform.outbox_events SET deletion_cancellation_audit_id=NULL WHERE id=${item.ids[0]}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM platform.outbox_events WHERE id=${item.ids[0]}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('detects physical loss of every cancellation link from the immutable owning audit witness', async () => {
    const item = await scene();
    await store.cancelNext(item.lease);
    const cancelled = (
      await sql<{
        id: string;
        audit: string;
      }>`SELECT id,deletion_cancellation_audit_id AS audit FROM platform.outbox_events
      WHERE deletion_cancellation_audit_id IN(SELECT id FROM platform.audit_logs WHERE subject_id=${item.lease.deletionRecordId}::uuid
        AND event_type='account.deletion-operational-batch.v1')`.execute(database)
    ).rows;
    expect(cancelled).toHaveLength(3);
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE platform.outbox_events SET deletion_cancellation_audit_id=NULL WHERE id IN(${sql.join(cancelled.map((row) => sql`${row.id}::uuid`))})`.execute(
        tx,
      );
    });
    expect(await store.cancelNext(item.lease)).toMatchObject({
      cancelledRows: 0,
      hasMore: true,
      blockedBy: 'proof_invalid',
    });
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      for (const row of cancelled)
        await sql`UPDATE platform.outbox_events SET deletion_cancellation_audit_id=${row.audit}::uuid WHERE id=${row.id}::uuid`.execute(
          tx,
        );
    });
    expect(await store.cancelNext(item.lease)).toMatchObject({
      cancelledRows: 0,
      hasMore: false,
      blockedBy: null,
    });
  });
  it('authenticates historical cancellation after worker expiry without lending new update authority', async () => {
    const item = await scene(1, 2000);
    await store.cancelNext(item.lease);
    await delay(2100);
    expect(
      (
        await sql`SELECT platform.deletion_event_cancellation_valid(event) AS valid FROM platform.outbox_events event WHERE id=${item.ids[0]}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
    await expect(store.cancelNext(item.lease)).rejects.toMatchObject({ status: 409 });
    const next = await claim();
    expect(next.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
    expect(await store.cancelNext(next)).toMatchObject({ cancelledRows: 0, hasMore: false });
  });
  it('advances only after ordinary absence, credit cutover and publication cancellation, then replays the exact original authority', async () => {
    const item = await scene();
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    expect(await checkpoints.finishProduct(item.lease)).toMatchObject({
      phase: 'product_data',
      waitingFor: 'ordinary_rows',
    });
    const product = new PostgresAccountDeletionProductStore(database);
    while ((await product.purgeNext(item.lease)).hasMore) {
      /* Bounded ordinary removal. */
    }
    const transport = new PostgresAccountDeletionTransportStore(database);
    while ((await transport.purgeNext(item.lease)).hasMore) {
      /* Bounded cached-response removal. */
    }
    expect(await checkpoints.finishProduct(item.lease)).toMatchObject({
      phase: 'product_data',
      waitingFor: 'credit_epoch',
    });
    await new PostgresAccountDeletionFinancialStore(database).prepareCreditEpoch(item.lease);
    expect(await checkpoints.finishProduct(item.lease)).toMatchObject({
      phase: 'product_data',
      waitingFor: 'publication',
    });
    await store.cancelNext(item.lease);
    expect(await checkpoints.finishProduct(item.lease)).toEqual({
      phase: 'media_objects',
      checkpointVersion: 4,
      replayed: false,
    });
    expect(await checkpoints.finishProduct(item.lease)).toEqual({
      phase: 'media_objects',
      checkpointVersion: 4,
      replayed: true,
    });
    const next = await claim();
    expect(next).toMatchObject({ phase: 'media_objects', checkpointVersion: 4 });
    await expect(
      checkpoints.finishProduct({ ...item.lease, leaseOwner: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await sql`SELECT product_purged_at,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${item.lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ product_purged_at: null, completed_at: null, reactivation_allowed: false }]);
  });
  async function readyProduct(): Promise<AccountDeletionLease> {
    const item = await scene();
    const product = new PostgresAccountDeletionProductStore(database),
      transport = new PostgresAccountDeletionTransportStore(database);
    while ((await product.purgeNext(item.lease)).hasMore) {
      /* Bounded ordinary removal. */
    }
    while ((await transport.purgeNext(item.lease)).hasMore) {
      /* Bounded response removal. */
    }
    await new PostgresAccountDeletionFinancialStore(database).prepareCreditEpoch(item.lease);
    await store.cancelNext(item.lease);
    return item.lease;
  }
  it.each(['audit', 'event', 'receipt', 'root', 'work'] as const)(
    'rolls back a suppressed checkpoint %s without claiming phase completion',
    async (kind) => {
      const lease = await readyProduct(),
        checkpoints = new PostgresAccountDeletionCheckpointStore(database);
      const table = {
        audit: 'platform.audit_logs',
        event: 'platform.outbox_events',
        receipt: 'identity.account_deletion_phase_receipts',
        root: 'identity.account_deletion_records',
        work: 'identity.account_deletion_work',
      }[kind];
      const predicate =
        kind === 'receipt'
          ? "NEW.completed_phase='product_data'"
          : kind === 'root' || kind === 'work'
            ? "NEW.phase='media_objects'"
            : "NEW.event_type='account.deletion-phase-completed.v1'";
      await sql
        .raw(
          `CREATE FUNCTION identity.product_checkpoint_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER a_product_checkpoint_suppress BEFORE ${kind === 'root' || kind === 'work' ? 'UPDATE' : 'INSERT'} ON ${table}
      FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION identity.product_checkpoint_suppress()`,
        )
        .execute(database);
      try {
        await expect(checkpoints.finishProduct(lease)).rejects.toMatchObject({ status: 409 });
        expect(
          (
            await sql`SELECT phase,checkpoint_version FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ phase: 'product_data', checkpoint_version: 3 }]);
        expect(
          (
            await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='product_data'`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await sql
          .raw(
            `DROP TRIGGER a_product_checkpoint_suppress ON ${table}; DROP FUNCTION identity.product_checkpoint_suppress()`,
          )
          .execute(database);
      }
      expect(await checkpoints.finishProduct(lease)).toMatchObject({
        phase: 'media_objects',
        checkpointVersion: 4,
        replayed: false,
      });
    },
  );
  it('rejects ordinary late storage and publication but preserves the limited return route', async () => {
    const lease = await readyProduct();
    await new PostgresAccountDeletionCheckpointStore(database).finishProduct(lease);
    await expect(
      sql`INSERT INTO identity.user_settings(user_id,ui_locale_code,visibility_enabled,version,created_at,updated_at)
      VALUES(${lease.userId}::uuid,'en',true,1,clock_timestamp(),clock_timestamp())`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      event(lease.userId, 'profile.updated.v1', {
        userId: lease.userId,
        profileId: randomUUID(),
        version: 1,
      }),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      event(lease.userId, 'telegram.start-route-requested.v1', {
        userId: lease.userId,
        entryRoute: 'return_decision',
        uiLocale: 'en',
      }),
    ).resolves.toEqual(expect.any(String));
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.user_settings WHERE user_id=${lease.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it('advances exactly once under twenty concurrent checkpoint retries', async () => {
    const lease = await readyProduct();
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkpoints.finishProduct(lease)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.every((result) => result.phase === 'media_objects')).toBe(true);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts
      WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='product_data'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('rechecks real lease expiry at deferred checkpoint commit and resumes without partial progress', async () => {
    const original = await readyProduct();
    await work.release(original);
    const lease = await claim(2000);
    await expect(
      database.transaction().execute(async (tx) => {
        const result = await new PostgresAccountDeletionCheckpointStore(tx).finishProduct(lease);
        expect(result.phase).toBe('media_objects');
        await sql`SELECT pg_sleep(2.1)`.execute(tx);
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'deletion phase completion chain incomplete',
    });
    expect(
      (
        await sql`SELECT phase,checkpoint_version FROM identity.account_deletion_records
      WHERE id=${lease.deletionRecordId}::uuid`.execute(database)
      ).rows,
    ).toEqual([{ phase: 'product_data', checkpoint_version: 3 }]);
    const next = await claim();
    expect(next.leaseGeneration).toBe(lease.leaseGeneration + 1);
    expect(
      await new PostgresAccountDeletionCheckpointStore(database).finishProduct(next),
    ).toMatchObject({ phase: 'media_objects', replayed: false });
  });
  it('blocks nonminimal operational metadata without discarding the retained audit', async () => {
    const lease = await readyProduct();
    const id = randomUUID();
    await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
      VALUES(${id}::uuid,'account','identity.fixture.v1','system','user',${lease.userId}::uuid,'fixture',1,
        '{"privateNote":"private content"}'::jsonb,${randomUUID()}::uuid,${randomUUID()}::uuid,clock_timestamp())`.execute(
      database,
    );
    expect(
      await new PostgresAccountDeletionCheckpointStore(database).finishProduct(lease),
    ).toMatchObject({ phase: 'product_data', waitingFor: 'operations' });
    expect(
      (await sql`SELECT metadata FROM platform.audit_logs WHERE id=${id}::uuid`.execute(database))
        .rows,
    ).toEqual([{ metadata: { privateNote: 'private content' } }]);
  });
  it.each(['row', 'event'] as const)(
    'locks an active source Account before a %s can outlive deletion',
    async (kind) => {
      const userId = await createReportUser(database, true);
      await database.transaction().execute(async (tx) => {
        if (kind === 'row')
          await sql`INSERT INTO identity.user_settings(user_id,ui_locale_code,visibility_enabled,version,created_at,updated_at)
        VALUES(${userId}::uuid,'en',true,1,clock_timestamp(),clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET version=identity.user_settings.version+1`.execute(
            tx,
          );
        else
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
        VALUES(${randomUUID()}::uuid,'user',${userId}::uuid,'profile.updated.v1',1,
          ${JSON.stringify({ userId, profileId: randomUUID(), version: 1 })}::jsonb,clock_timestamp(),clock_timestamp(),${randomUUID()}::uuid,${randomUUID()}::uuid)`.execute(
            tx,
          );
        await expect(
          database
            .transaction()
            .execute((other) =>
              sql`SELECT user_id FROM identity.accounts WHERE user_id=${userId}::uuid FOR UPDATE NOWAIT`.execute(
                other,
              ),
            ),
        ).rejects.toMatchObject({ code: '55P03' });
      });
      await expect(
        database
          .transaction()
          .execute((tx) =>
            sql`SELECT user_id FROM identity.accounts WHERE user_id=${userId}::uuid FOR UPDATE NOWAIT`.execute(
              tx,
            ),
          ),
      ).resolves.toMatchObject({ rows: [{ user_id: userId }] });
    },
  );
});
