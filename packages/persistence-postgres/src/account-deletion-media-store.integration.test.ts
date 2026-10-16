import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecuteAccountDeletionMedia,
  AesGcmPhotoReportSnapshotReader,
  type AccountDeletionLease,
  type AccountDeletionMediaObjects,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createRetainedReportPhoto, createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionEvidenceStore } from './account-deletion-evidence-store.js';
import { PostgresAccountDeletionPhotoStore } from './account-deletion-photo-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionLikeStore } from './account-deletion-like-store.js';
import { PostgresAccountDeletionReferencedLikeStore } from './account-deletion-referenced-like-store.js';
import { authenticateReportEvidenceInTransaction } from './report-capture-integrity.js';
import { seedValidMedia } from './media-fixtures.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';
import { PostgresAccountDeletionTransportStore } from './account-deletion-transport-store.js';
import { PostgresAccountDeletionFinancialStore } from './account-deletion-financial-store.js';
import { PostgresAccountDeletionOperationalStore } from './account-deletion-operational-store.js';
import { PostgresAccountDeletionMediaStore } from './account-deletion-media-store.js';
import { PostgresModerationIntegrityMetricsStore } from './moderation-integrity-metrics-store.js';
import { PostgresModerationReconciliationStore } from './moderation-reconciliation-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 owning account media provider work', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    work: PostgresAccountDeletionWorkStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_account_media');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
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
  async function claim(): Promise<AccountDeletionLease> {
    const rows = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function scene(withReport = false): Promise<{
    lease: AccountDeletionLease;
    assetId: string;
    captured: Awaited<ReturnType<typeof createRetainedReportPhoto>> | undefined;
    reportBytes: Uint8Array;
  }> {
    let captured: Awaited<ReturnType<typeof createRetainedReportPhoto>> | undefined;
    const reportBytes = new Uint8Array([1, 2, 3, 4]);
    const assetId = randomUUID();
    const item = await createDeletionFixture(database, async (owner) => {
      await seedValidMedia(database, owner, assetId);
      if (withReport) {
        await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${owner}::uuid`.execute(
          database,
        );
        const template = await createReportUser(database, true);
        await sql`INSERT INTO profile.profiles(id,user_id,name,birth_year,gender_option_id,gender_preference_id,relationship_goal_id,country_id,province_id,city_id,
          highlight,bio,completion_status,ever_completed,completed_at,created_at,updated_at)
          SELECT ${randomUUID()}::uuid,${owner}::uuid,name,birth_year,gender_option_id,gender_preference_id,relationship_goal_id,country_id,province_id,city_id,
            highlight,bio,completion_status,ever_completed,completed_at,created_at,updated_at FROM profile.profiles WHERE user_id=${template}::uuid`.execute(
          database,
        );
        captured = await createRetainedReportPhoto(database, reportBytes, owner);
        await sql`INSERT INTO platform.user_counters(user_id) VALUES(${captured.reporter}::uuid) ON CONFLICT(user_id) DO NOTHING`.execute(
          database,
        );
      }
    });
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    const shared = await claim();
    while ((await new PostgresAccountDeletionSharedStore(database).closeNext(shared)).hasMore) {
      /* bounded */
    }
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    if (captured !== undefined) {
      const photo = new AesGcmPhotoReportSnapshotReader({
        resolve: (id, version) =>
          id === 'photo-fixture' && version === 1 ? captured!.key : undefined,
      });
      await new PostgresAccountDeletionEvidenceStore(database, { photo }).verifyNext(evidence);
      while (
        (await new PostgresAccountDeletionPhotoStore(database).archiveNext(evidence)).hasMore
      ) {
        /* bounded */
      }
      await new PostgresAccountDeletionProfileStore(database).archive(evidence);
    }
    await checkpoints.finishEvidence(evidence);
    const product = await claim();
    while ((await new PostgresAccountDeletionProductStore(database).purgeNext(product)).hasMore) {
      /* bounded */
    }
    while ((await new PostgresAccountDeletionTransportStore(database).purgeNext(product)).hasMore) {
      /* bounded */
    }
    while (
      (await new PostgresAccountDeletionReferencedLikeStore(database).purgeNext(product)).hasMore
    ) {
      /* bounded */
    }
    while ((await new PostgresAccountDeletionLikeStore(database).purgeNext(product)).hasMore) {
      /* bounded unreferenced */
    }
    await new PostgresAccountDeletionFinancialStore(database).prepareCreditEpoch(product);
    await new PostgresAccountDeletionOperationalStore(database).cancelNext(product);
    const productResult = await checkpoints.finishProduct(product);
    if (productResult.phase !== 'media_objects') {
      const remaining: string[] = [];
      const selectors = (
        await sql<{
          selectors: readonly { table: string; predicate: string }[];
        }>`SELECT identity.deletion_product_selectors() AS selectors`.execute(database)
      ).rows[0]!.selectors;
      for (const selector of selectors) {
        const present = (
          await sql<{
            present: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM ${sql.table(selector.table)} row WHERE ${sql.join(
            selector.predicate.split('$1').map((part) => sql.raw(part)),
            sql`${product.userId}::uuid`,
          )}) AS present`.execute(database)
        ).rows[0]!.present;
        if (present) remaining.push(selector.table);
      }
      const unknown = (
        await sql`SELECT DISTINCT event_type FROM platform.outbox_events event WHERE platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='unclassified'`.execute(
          database,
        )
      ).rows;
      const audits = (
        await sql`SELECT event_type,(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(metadata) key) AS fields
        FROM platform.audit_logs WHERE subject_id=${product.deletionRecordId}::uuid OR actor_user_id=${product.userId}::uuid ORDER BY event_type`.execute(
          database,
        )
      ).rows;
      throw Error(
        'Media fixture product blocker ' +
          JSON.stringify({ result: productResult, remaining, unknown, audits }),
      );
    }
    expect(productResult).toMatchObject({
      phase: 'media_objects',
      checkpointVersion: 4,
    });
    const lease = await claim();
    expect(lease.deletionRecordId).toBe(item.recordId);
    return { lease, assetId, captured, reportBytes };
  }
  it('prepares one original owned object under twenty retries without advancing completion', async () => {
    const { lease, assetId } = await scene();
    const store = new PostgresAccountDeletionMediaStore(database, 'test');
    const operations = await Promise.all(Array.from({ length: 20 }, () => store.claimNext(lease)));
    expect(new Set(operations.map((operation) => operation?.id)).size).toBe(1);
    expect(
      await new PostgresAccountDeletionCheckpointStore(database).finishMedia(lease),
    ).toMatchObject({ phase: 'media_objects', waitingFor: 'sources' });
    expect(operations[0]).toMatchObject({
      assetId,
      userId: lease.userId,
      kind: 'delete_public',
      key: `quarantine/test/${assetId}/original`,
    });
    expect(
      (
        await sql`SELECT completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ completed_at: null, reactivation_allowed: false }]);
  });
  it.each(['audit', 'event', 'receipt', 'root', 'work'] as const)(
    'rolls back a suppressed media checkpoint %s and resumes from the same lease',
    async (kind) => {
      const { lease } = await scene();
      const store = new PostgresAccountDeletionMediaStore(database, 'test');
      const executor = new ExecuteAccountDeletionMedia(
        store,
        {
          list: () => Promise.resolve([]),
          get: () => Promise.reject(Error('unused')),
          putPrivate: () => Promise.reject(Error('unused')),
          delete: async () => {
            await Promise.resolve();
          },
          head: () => Promise.resolve(undefined),
        },
        {
          purge: async () => {
            await Promise.resolve();
          },
        },
        'test',
      );
      while ((await executor.executeNext(lease)).worked) {
        /* bounded provider operations */
      }
      expect(await store.archiveNext(lease)).toEqual({ archived: true, hasMore: false });
      const table = {
        audit: 'platform.audit_logs',
        event: 'platform.outbox_events',
        receipt: 'identity.account_deletion_phase_receipts',
        root: 'identity.account_deletion_records',
        work: 'identity.account_deletion_work',
      }[kind];
      const predicate =
        kind === 'receipt'
          ? "NEW.completed_phase='media_objects'"
          : kind === 'root' || kind === 'work'
            ? "NEW.phase='ephemeral_access'"
            : "NEW.event_type='account.deletion-phase-completed.v1'";
      await sql
        .raw(
          `CREATE FUNCTION identity.media_checkpoint_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER a_media_checkpoint_suppress BEFORE ${kind === 'root' || kind === 'work' ? 'UPDATE' : 'INSERT'} ON ${table}
        FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION identity.media_checkpoint_suppress()`,
        )
        .execute(database);
      const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
      try {
        await expect(checkpoints.finishMedia(lease)).rejects.toMatchObject({ status: 409 });
        expect(
          (
            await sql`SELECT phase,checkpoint_version FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ phase: 'media_objects', checkpoint_version: 4 }]);
        expect(
          (
            await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='media_objects'`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await sql
          .raw(
            `DROP TRIGGER a_media_checkpoint_suppress ON ${table}; DROP FUNCTION identity.media_checkpoint_suppress()`,
          )
          .execute(database);
      }
      expect(await checkpoints.finishMedia(lease)).toMatchObject({
        phase: 'ephemeral_access',
        checkpointVersion: 5,
        replayed: false,
      });
    },
  );
  it('requires actual object absence and cache acknowledgement before each audited provider observation', async () => {
    const { lease, assetId } = await scene();
    const store = new PostgresAccountDeletionMediaStore(database, 'test');
    const objects = new Set([
      `quarantine/test/${assetId}/original`,
      `validated/test/${assetId}/original`,
      `variants/test/${assetId}/thumbnail-v1.webp`,
    ]);
    const calls: string[] = [];
    const provider: AccountDeletionMediaObjects = {
      list: (prefix, limit) =>
        Promise.resolve(
          [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit),
        ),
      get: () => Promise.reject(Error('unused')),
      putPrivate: () => Promise.reject(Error('unused')),
      delete: async (key) => {
        await Promise.resolve();
        calls.push(key);
        objects.delete(key);
      },
      head: (key) =>
        Promise.resolve(objects.has(key) ? { bytes: 1, sha256: 'a'.repeat(64) } : undefined),
    };
    const purges: string[] = [];
    const executor = new ExecuteAccountDeletionMedia(
      store,
      provider,
      {
        purge: async (paths) => {
          await Promise.resolve();
          purges.push(...paths);
        },
      },
      'test',
    );
    for (let index = 0; index < 4; index++)
      expect(await executor.executeNext(lease)).toEqual({ worked: true });
    expect(await executor.executeNext(lease)).toEqual({ worked: false });
    expect(objects.size).toBe(0);
    const archived = await Promise.all(Array.from({ length: 20 }, () => store.archiveNext(lease)));
    expect(archived.filter((result) => result.archived)).toHaveLength(1);
    expect(archived.every((result) => !result.hasMore)).toBe(true);
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    const authority = (
      await sql`SELECT root.phase,root.checkpoint_version,job.phase AS job_phase,job.checkpoint_version AS job_checkpoint,
      job.lease_owner=${lease.leaseOwner}::uuid AS owner_matches,job.lease_generation=${lease.leaseGeneration} AS generation_matches,
      job.lease_expires_at>clock_timestamp() AS lease_live,(SELECT pending_nakh_count FROM platform.user_counters WHERE user_id=root.user_id) AS pending,
      identity.deletion_has_open_shared_scopes(root.user_id) AS open_scopes
      FROM identity.account_deletion_records root JOIN identity.account_deletion_work job ON job.deletion_record_id=root.id WHERE root.id=${lease.deletionRecordId}::uuid`.execute(
        database,
      )
    ).rows;
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => checkpoints.finishMedia(lease)),
    );
    const failures = settled.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      const after = (
        await sql`SELECT phase,checkpoint_version FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows;
      try {
        await sql`SELECT * FROM identity.finish_deletion_media_phase(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration},${lease.checkpointVersion})`.execute(
          database,
        );
      } catch (error) {
        const detail = error as { message?: string; code?: string; where?: string };
        throw Error(
          'Media checkpoint authority ' +
            JSON.stringify({
              authority,
              after,
              code: detail.code,
              message: detail.message,
              where: detail.where,
            }),
          { cause: error },
        );
      }
      throw Error('Media checkpoint authority ' + JSON.stringify({ authority, after }));
    }
    const transitions = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(transitions.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      transitions.every(
        (result) => result.phase === 'ephemeral_access' && result.checkpointVersion === 5,
      ),
    ).toBe(true);
    expect(await checkpoints.finishMedia(lease)).toEqual({
      phase: 'ephemeral_access',
      checkpointVersion: 5,
      replayed: true,
    });

    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM media.media_assets WHERE id=${assetId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM media.photo_variants WHERE asset_id=${assetId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(calls).toHaveLength(3);
    expect(purges).toEqual([`/media/${assetId}/thumbnail-v1.webp`]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_media_operations WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND verified_at IS NOT NULL`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 4 }]);
  });
  it('rejects another worker generation without exposing a provider scope', async () => {
    const { lease } = await scene();
    const store = new PostgresAccountDeletionMediaStore(database, 'test');
    await expect(
      store.claimNext({ ...lease, leaseGeneration: lease.leaseGeneration + 1 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_media_operations WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it('preserves authenticated report evidence in private storage after every public object and raw media source is removed', async () => {
    const item = await scene(true);
    const capture = item.captured!;
    const metrics = new PostgresModerationIntegrityMetricsStore(database);
    const baselineEvidence = (await metrics.measure()).counts.evidence;
    const reconcile = async (): Promise<unknown[]> => {
      const scanner = new PostgresModerationReconciliationStore(database);
      const runId = await scanner.resumeOrStart(randomUUID());
      let completed = false;
      for (let batch = 0; batch < 100 && !completed; batch++)
        completed = (await scanner.scanNextBatch(runId, 500)).completed;
      expect(completed).toBe(true);
      return database
        .selectFrom('billing.reconciliation_anomalies')
        .select(['anomaly_type', 'disposition', 'safe_detail'])
        .where('entity_id', '=', capture.reportId)
        .where('anomaly_type', '=', 'report_photo_retention_invalid')
        .execute();
    };
    const readers = {
      photo: new AesGcmPhotoReportSnapshotReader({
        resolve: (id, version) =>
          id === 'photo-fixture' && version === 1 ? capture.key : undefined,
      }),
    };
    const read = (): ReturnType<typeof authenticateReportEvidenceInTransaction> =>
      database
        .transaction()
        .execute((tx) => authenticateReportEvidenceInTransaction(tx, readers, capture.evidenceId));
    const before = await read();
    const fingerprint = (
      await sql`SELECT capture_fingerprint FROM identity.account_deletion_evidence_receipts WHERE deletion_record_id=${item.lease.deletionRecordId}::uuid`.execute(
        database,
      )
    ).rows;
    const keys = (
      await sql<{
        key: string;
      }>`SELECT quarantine_key AS key FROM media.media_assets WHERE owner_user_id=${item.lease.userId}::uuid
      UNION ALL SELECT validated_key FROM media.media_assets WHERE owner_user_id=${item.lease.userId}::uuid AND validated_key IS NOT NULL
      UNION ALL SELECT variant.storage_key FROM media.photo_variants variant JOIN media.media_assets asset ON asset.id=variant.asset_id WHERE asset.owner_user_id=${item.lease.userId}::uuid`.execute(
        database,
      )
    ).rows;
    const objects = new Map(keys.map((row) => [row.key, item.reportBytes]));
    const provider: AccountDeletionMediaObjects = {
      list: (prefix, limit) =>
        Promise.resolve(
          [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit),
        ),
      get: async (key) => {
        await Promise.resolve();
        const bytes = objects.get(key);
        if (bytes === undefined) throw Error('fixture_missing');
        return (async function* () {
          yield await Promise.resolve(bytes);
        })();
      },
      putPrivate: async (key, body) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        objects.set(key, bytes);
        return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
      delete: async (key) => {
        await Promise.resolve();
        objects.delete(key);
      },
      head: async (key) => {
        await Promise.resolve();
        const bytes = objects.get(key);
        return bytes === undefined
          ? undefined
          : { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
    };
    const store = new PostgresAccountDeletionMediaStore(database, 'test');
    const executor = new ExecuteAccountDeletionMedia(
      store,
      provider,
      {
        purge: async () => {
          await Promise.resolve();
        },
      },
      'test',
    );
    for (let index = 0; index < 20; index++) {
      if (!(await executor.executeNext(item.lease)).worked) break;
    }
    while ((await store.archiveNext(item.lease)).hasMore) {
      /* bounded */
    }
    expect([...objects.keys()]).toEqual([`evidence/test/${capture.evidenceId}/thumbnail-v1.webp`]);
    expect(await read()).toEqual(before);
    expect((await metrics.measure()).counts.evidence).toBe(baselineEvidence);
    expect(await reconcile()).toEqual([]);
    expect(
      (
        await sql`SELECT capture_fingerprint FROM identity.account_deletion_evidence_receipts WHERE deletion_record_id=${item.lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(fingerprint);
    expect(
      (
        await sql`SELECT identity.deletion_private_photo_valid(${capture.evidenceId}::uuid) AS valid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
    // Genuine native private custody survives an equivalent populated-view
    // upgrade after the public objects/rows are gone. Compare hashes only so a
    // failing assertion cannot print provider keys. DDL rollback restores the
    // current view if any assertion fails; no source row or proof is rewritten.
    const legacyMigration = await readFile(
      resolve('migrations/000129_m8_account_media_provider_work.sql'),
      'utf8',
    );
    const legacyStart = legacyMigration.indexOf('CREATE VIEW media.report_photo_source_facts AS');
    const legacyEnd = legacyMigration.indexOf(
      'CREATE OR REPLACE FUNCTION media.guard_photo_evidence_asset_cleanup',
      legacyStart,
    );
    const legacyView = legacyMigration
      .slice(legacyStart, legacyEnd)
      .replace('CREATE VIEW', 'CREATE OR REPLACE VIEW');
    const currentView = (
      await sql<{
        definition: string;
      }>`SELECT pg_get_viewdef('media.report_photo_source_facts'::regclass,true) AS definition`.execute(
        database,
      )
    ).rows[0]!.definition;
    await database.transaction().execute(async (tx) => {
      const sourceHash = async (): Promise<readonly { fingerprint: string }[]> =>
        (
          await sql<{ fingerprint: string }>`
        SELECT encode(sha256(convert_to(to_jsonb(fact)::text,'UTF8')),'hex') AS fingerprint
        FROM media.report_photo_source_facts fact WHERE report_evidence_id=${capture.evidenceId}::uuid`.execute(
            tx,
          )
        ).rows;
      await sql.raw(legacyView).execute(tx);
      const original = await sourceHash();
      expect(original).toHaveLength(1);
      await sql
        .raw('CREATE OR REPLACE VIEW media.report_photo_source_facts AS ' + currentView)
        .execute(tx);
      expect(await sourceHash()).toEqual(original);
    });
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE identity.account_deletion_media_operations SET verified_sha256=repeat('f',64)
        WHERE evidence_id=${capture.evidenceId}::uuid AND kind='retain_photo'`.execute(tx);
    });
    await expect(read()).rejects.toThrow('Report snapshot reference is invalid.');
    const damagedSample = await metrics.measure();
    expect(damagedSample.counts.evidence).toBe(baselineEvidence + 1);
    expect(JSON.stringify(damagedSample)).not.toContain(capture.evidenceId);
    expect(await reconcile()).toEqual([
      {
        anomaly_type: 'report_photo_retention_invalid',
        disposition: 'quarantined',
        safe_detail: { evidenceType: 'photo' },
      },
    ]);
    expect(await reconcile()).toHaveLength(1);
    await expect(store.archiveNext(item.lease)).rejects.toMatchObject({ status: 409 });
    expect(
      await new PostgresAccountDeletionCheckpointStore(database).finishMedia(item.lease),
    ).toMatchObject({ phase: 'media_objects', waitingFor: 'product' });
    capture.key.fill(0);
  });
});
