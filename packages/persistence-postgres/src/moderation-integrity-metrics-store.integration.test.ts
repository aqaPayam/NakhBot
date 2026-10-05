import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmReviewNoteProtector,
  MODERATION_RECONCILIATION_PHASES,
  canonicalAdminPairTargetId,
  type InternalBlockDraft,
  type ReviewDecisionDraft,
} from '@nakh/application';
import { normalizeUserPair } from '@nakh/domain';
import type { PrepareAccountModerationActionCommand } from '@nakh/contracts';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';
import { createDatabase, REPORT_SNAPSHOT_STORED_COLUMNS, type NakhDatabase } from './database.js';
import { PostgresM7OperationalHealthStore } from './moderation-operational-health-store.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import {
  createRetainedReportPhoto,
  createRetainedPhotoReview,
  createReportFixtureAdmin,
} from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresModerationIntegrityMetricsStore } from './moderation-integrity-metrics-store.js';
import { PostgresModerationReconciliationStore } from './moderation-reconciliation-store.js';
import { PostgresConfirmedInternalBlocks } from './confirmed-internal-block-store.js';
import { PostgresConfirmedReviewDecisions } from './confirmed-review-decision-store.js';
import { scanModerationActions } from './moderation-review-reconciliation.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'current aggregate M7 integrity from authoritative metadata',
  () => {
    let database: NakhDatabase;
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'nakh_m7_integrity');
      await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 20,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
    });
    afterAll(async () => {
      try {
        await database?.destroy();
      } finally {
        await isolated?.destroy();
      }
    });
    async function corrupt(operation: (connection: NakhDatabase) => Promise<void>): Promise<void> {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role = replica`.execute(connection);
        try {
          await operation(connection);
        } finally {
          await sql`SET session_replication_role = origin`.execute(connection);
        }
      });
    }
    it('returns all ten current counts, one database time and no identities under concurrent sampling', async () => {
      const store = new PostgresModerationIntegrityMetricsStore(database);
      const samples = await Promise.all(Array.from({ length: 12 }, () => store.measure()));
      for (const sample of samples) {
        expect(sample.sampledAt).toBeInstanceOf(Date);
        expect(sample.sampledAt.getTime()).toBeGreaterThan(0);
        expect(Object.keys(sample.counts).sort()).toEqual(
          [...MODERATION_RECONCILIATION_PHASES].sort(),
        );
        expect(Object.values(sample.counts)).toEqual(Array.from({ length: 10 }, () => 0));
        expect(Object.keys(sample).sort()).toEqual(['counts', 'sampledAt']);
      }
      expect(
        await database.selectFrom('billing.reconciliation_runs').select('id').execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom('billing.reconciliation_anomalies').select('id').execute(),
      ).toHaveLength(0);
    });
    it('detects live snapshot drift and clears it after repair while the historical quarantine remains', async () => {
      const photo = await createRetainedReportPhoto(database);
      const snapshot = await database
        .selectFrom('moderation.report_snapshots')
        .select(REPORT_SNAPSHOT_STORED_COLUMNS)
        .where('report_evidence_id', '=', photo.evidenceId)
        .executeTakeFirstOrThrow();
      const store = new PostgresModerationIntegrityMetricsStore(database);
      expect((await store.measure()).counts.evidence).toBe(0);
      await corrupt(async (connection) => {
        await connection
          .deleteFrom('moderation.report_snapshots')
          .where('id', '=', snapshot.id)
          .execute();
      });
      try {
        const broken = await store.measure();
        expect(broken.counts.evidence).toBe(1);
        for (const phase of MODERATION_RECONCILIATION_PHASES.filter((p) => p !== 'evidence'))
          expect(broken.counts[phase]).toBe(0);
        const scan = new PostgresModerationReconciliationStore(database),
          run = await scan.resumeOrStart(randomUUID());
        let done = false;
        for (let i = 0; i < 30 && !done; i++) done = (await scan.scanNextBatch(run, 500)).completed;
        expect(done).toBe(true);
        expect(
          await database
            .selectFrom('billing.reconciliation_anomalies')
            .select('id')
            .where('entity_id', '=', photo.reportId)
            .execute(),
        ).toHaveLength(1);
        for (const secret of [
          photo.reportId,
          photo.evidenceId,
          photo.reporter,
          photo.target,
          photo.content.evidenceObjectRef,
        ])
          expect(JSON.stringify(broken)).not.toContain(secret);
      } finally {
        await corrupt(async (connection) => {
          await connection.insertInto('moderation.report_snapshots').values(snapshot).execute();
        });
      }
      expect((await store.measure()).counts.evidence).toBe(0);
      expect(
        await database
          .selectFrom('billing.reconciliation_anomalies')
          .select('id')
          .where('entity_id', '=', photo.reportId)
          .execute(),
      ).toHaveLength(1);
    });
    it('recomputes stored shape after privileged input drift and forbids caller-supplied validity', async () => {
      const photo = await createRetainedReportPhoto(database);
      const store = new PostgresModerationIntegrityMetricsStore(database),
        health = new PostgresM7OperationalHealthStore(database);
      const baseline = await store.measure(),
        healthBaseline = await health.measure();
      await expect(
        sql`UPDATE moderation.report_snapshots SET metadata_shape_valid=false WHERE report_evidence_id=${photo.evidenceId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '428C9' });
      await corrupt(async (tx) => {
        await sql`UPDATE moderation.report_snapshots SET schema_version=2 WHERE report_evidence_id=${photo.evidenceId}::uuid`.execute(
          tx,
        );
      });
      try {
        const snapshot = await database
          .selectFrom('moderation.report_snapshots')
          .select('metadata_shape_valid')
          .where('report_evidence_id', '=', photo.evidenceId)
          .executeTakeFirstOrThrow();
        expect(snapshot.metadata_shape_valid).toBe(false);
        for (const sample of await Promise.all(Array.from({ length: 5 }, () => store.measure())))
          expect(sample.counts.evidence).toBe(baseline.counts.evidence + 1);
        expect((await health.measure()).snapshotIntegrityFailureCount).toBe(
          healthBaseline.snapshotIntegrityFailureCount + 1,
        );
      } finally {
        await corrupt(async (tx) => {
          await sql`UPDATE moderation.report_snapshots SET schema_version=1 WHERE report_evidence_id=${photo.evidenceId}::uuid`.execute(
            tx,
          );
        });
      }
      expect((await store.measure()).counts).toEqual(baseline.counts);
      expect((await health.measure()).snapshotIntegrityFailureCount).toBe(
        healthBaseline.snapshotIntegrityFailureCount,
      );
    });
    it('preserves exact capture and custody bindings through joined evidence and clears repaired drift', async () => {
      const photo = await createRetainedReportPhoto(database),
        other = await createRetainedReportPhoto(database);
      const hold = await database
        .selectFrom('media.report_photo_evidence_holds')
        .selectAll()
        .where('report_evidence_id', '=', photo.evidenceId)
        .executeTakeFirstOrThrow();
      const store = new PostgresModerationIntegrityMetricsStore(database);
      const baseline = await store.measure();
      for (const damage of [
        sql`UPDATE media.report_photo_evidence_holds SET content_sha256=repeat('b',64) WHERE report_evidence_id=${photo.evidenceId}::uuid`,
        sql`UPDATE media.report_photo_evidence_holds SET photo_id=${other.photoId}::uuid WHERE report_evidence_id=${photo.evidenceId}::uuid`,
        sql`UPDATE media.report_photo_evidence_holds SET asset_id=(
          SELECT asset_id FROM media.report_photo_evidence_holds WHERE report_evidence_id=${other.evidenceId}::uuid
        ) WHERE report_evidence_id=${photo.evidenceId}::uuid`,
        sql`UPDATE media.photo_variants SET deleted_at=now(),storage_deleted_at=now() WHERE id=${hold.variant_id}::uuid`,
        sql`UPDATE media.media_assets SET deleted_at=now(),storage_deleted_at=now() WHERE id=${hold.asset_id}::uuid`,
        sql`UPDATE moderation.report_snapshots SET report_id=${other.reportId}::uuid WHERE report_evidence_id=${photo.evidenceId}::uuid`,
      ]) {
        await corrupt(async (connection) => {
          await damage.execute(connection);
        });
        try {
          const rows = (
            await sql<{ id: string; hasCapture: boolean; hasRetainedPhoto: boolean }>`
            SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.evidence}) probe
            WHERE probe.id=${photo.evidenceId}::uuid ORDER BY probe.id LIMIT 2`.execute(database)
          ).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]!.hasCapture && rows[0]!.hasRetainedPhoto).toBe(false);
          const samples = await Promise.all(Array.from({ length: 5 }, () => store.measure()));
          for (const sample of samples) {
            expect(sample.counts.evidence).toBe(baseline.counts.evidence + 1);
            expect(JSON.stringify(sample)).not.toContain(photo.evidenceId);
            expect(JSON.stringify(sample)).not.toContain(hold.content_sha256);
          }
        } finally {
          await corrupt(async (connection) => {
            await sql`UPDATE media.report_photo_evidence_holds SET photo_id=${hold.photo_id}::uuid,asset_id=${hold.asset_id}::uuid,content_sha256=${hold.content_sha256} WHERE report_evidence_id=${photo.evidenceId}::uuid`.execute(
              connection,
            );
            await sql`UPDATE media.photo_variants SET asset_id=${hold.asset_id}::uuid,deleted_at=NULL,storage_deleted_at=NULL WHERE id=${hold.variant_id}::uuid`.execute(
              connection,
            );
            await sql`UPDATE media.media_assets SET deleted_at=NULL,storage_deleted_at=NULL WHERE id=${hold.asset_id}::uuid`.execute(
              connection,
            );
            await sql`UPDATE moderation.report_snapshots SET report_id=${photo.reportId}::uuid WHERE report_evidence_id=${photo.evidenceId}::uuid`.execute(
              connection,
            );
          });
        }
        expect((await store.measure()).counts).toEqual(baseline.counts);
      }
    });
    it('preserves native restriction audit and notice bindings through unique joins', async () => {
      const photo = await createRetainedReportPhoto(database),
        other = await createRetainedReportPhoto(database),
        adminId = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: adminId,
          role_code: 'super_admin',
          assigned_by_admin_id: adminId,
          revoked_at: null,
          revoked_by_admin_id: null,
        })
        .execute();
      const f = await confirmationFixture(database, adminId),
        workflow = new PostgresConfirmedAccountActions(database, f.tokens, f.key),
        account = await database
          .selectFrom('identity.accounts')
          .select('version')
          .where('user_id', '=', photo.target)
          .executeTakeFirstOrThrow();
      const command: PrepareAccountModerationActionCommand = {
        actor: f.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.apply-account-action',
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          action: 'restrict_user',
          reason: 'Native integrity binding evidence',
          expectedTargetVersion: account.version,
          adminActionToken: await f.issue({
            commandCode: 'moderation.apply-account-action',
            requiredPermission: 'restrict_user',
            targetType: 'user',
            targetId: photo.target,
            expectedTargetVersion: account.version,
          }),
        },
      };
      expect(
        (
          await workflow.execute(
            {
              ...command,
              data: {
                ...command.data,
                confirmationToken: await workflow.prepare(command, f.actor),
              },
            },
            f.actor,
          )
        ).result,
      ).toBe('succeeded');
      const action = await database
        .selectFrom('moderation.moderation_actions')
        .selectAll()
        .where('command_id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      const audit = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('id', '=', action.audit_log_id)
        .executeTakeFirstOrThrow();
      const store = new PostgresModerationIntegrityMetricsStore(database),
        baseline = (await store.measure()).counts;
      for (const [damage, code] of [
        [
          sql`UPDATE platform.audit_logs SET command_id=${randomUUID()}::uuid WHERE id=${audit.id}::uuid`,
          'moderation_action_audit_missing',
        ],
        [
          sql`UPDATE platform.audit_logs SET request_id=${randomUUID()}::uuid WHERE id=${audit.id}::uuid`,
          'moderation_action_audit_missing',
        ],
        [
          sql`UPDATE notification.notifications SET user_id=${other.target}::uuid WHERE id=${action.notification_id}::uuid`,
          'moderation_action_notice_invalid',
        ],
      ] as const) {
        await corrupt(async (tx) => {
          await damage.execute(tx);
        });
        try {
          const scan = await scanModerationActions(database, { phase: 'actions' }, 500);
          expect(
            scan.findings.filter((row) => row.entityId === action.id).map((row) => row.anomalyType),
          ).toEqual([code]);
          for (const sample of await Promise.all(Array.from({ length: 5 }, () => store.measure())))
            expect(sample.counts.actions).toBe(baseline.actions + 1);
        } finally {
          await corrupt(async (tx) => {
            await sql`UPDATE platform.audit_logs SET command_id=${audit.command_id}::uuid,request_id=${audit.request_id}::uuid WHERE id=${audit.id}::uuid`.execute(
              tx,
            );
            await sql`UPDATE notification.notifications SET user_id=${photo.target}::uuid WHERE id=${action.notification_id}::uuid`.execute(
              tx,
            );
          });
        }
        expect((await store.measure()).counts).toEqual(baseline);
      }
    });
    it('accepts actual Report-bound block creation/removal and dismissal without false action quarantines', async () => {
      const photo = await createRetainedReportPhoto(database),
        adminId = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: adminId,
          role_code: 'super_admin',
          assigned_by_admin_id: adminId,
          revoked_at: null,
          revoked_by_admin_id: null,
        })
        .execute();
      const f = await confirmationFixture(database, adminId),
        pair = normalizeUserPair(photo.reporter, photo.target);
      const commands = new PostgresConfirmedInternalBlocks(database, f.tokens, f.key);
      for (const action of ['create', 'remove'] as const) {
        const id = randomUUID(),
          draft: InternalBlockDraft = {
            actor: f.actor,
            commandId: id,
            requestId: id,
            idempotencyKey: id,
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            locale: 'en',
            commandType: 'moderation.change-internal-block',
            data: {
              action,
              reason: 'Exact report pair',
              expectedTargetVersion: 1,
              adminActionToken: await f.issue({
                commandCode: 'moderation.change-internal-block',
                requiredPermission: 'manage_internal_blocks',
                targetType: 'user_pair',
                targetId: canonicalAdminPairTargetId(pair),
                targetPair: pair,
                expectedTargetVersion: 1,
                sourceReportId: photo.reportId,
              }),
            },
          };
        expect(
          await commands.execute(
            {
              ...draft,
              data: { ...draft.data, confirmationToken: await commands.prepare(draft, f.actor) },
            },
            f.actor,
          ),
        ).toMatchObject({ result: 'succeeded' });
      }
      const review = await createRetainedPhotoReview(database);
      await database
        .updateTable('moderation.moderation_reviews')
        .set({
          status: 'in_review',
          assigned_admin_id: adminId,
          assigned_at: sql<Date>`clock_timestamp()`,
          updated_at: sql<Date>`clock_timestamp()`,
          version: 2,
        })
        .where('id', '=', review.reviewId)
        .execute();
      const decisions = new PostgresConfirmedReviewDecisions(
        database,
        f.tokens,
        f.key,
        new AesGcmReviewNoteProtector('integrity-fixture', 1, Buffer.alloc(32, 71)),
      );
      const id = randomUUID(),
        draft: ReviewDecisionDraft = {
          actor: f.actor,
          commandId: id,
          requestId: id,
          idempotencyKey: id,
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          commandType: 'moderation.decide-review',
          data: {
            decision: 'dismissed',
            reason: 'Dismiss selected report',
            expectedTargetVersion: 2,
            adminActionToken: await f.issue({
              commandCode: 'moderation.decide-review',
              requiredPermission: 'dismiss_report',
              targetType: 'moderation_review',
              targetId: review.reviewId,
              expectedTargetVersion: 2,
            }),
          },
        };
      expect(
        await decisions.execute(
          {
            ...draft,
            data: { ...draft.data, confirmationToken: await decisions.prepare(draft, f.actor) },
          },
          f.actor,
        ),
      ).toMatchObject({ result: 'succeeded' });
      expect((await scanModerationActions(database, { phase: 'actions' }, 500)).findings).toEqual(
        [],
      );
      const sample = await new PostgresModerationIntegrityMetricsStore(database).measure();
      expect(Object.values(sample.counts)).toEqual(Array.from({ length: 10 }, () => 0));
      const store = new PostgresModerationIntegrityMetricsStore(database);
      const block = await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('source_report_id', '=', photo.reportId)
        .where('action_type', '=', 'create_internal_block')
        .executeTakeFirstOrThrow();
      const wrongPair = normalizeUserPair(review.reporter, review.target);
      await corrupt(async (connection) => {
        await connection
          .updateTable('moderation.moderation_actions')
          .set({
            target_pair_low_user_id: wrongPair.userLowId,
            target_pair_high_user_id: wrongPair.userHighId,
          })
          .where('id', '=', block.id)
          .execute();
      });
      try {
        expect((await store.measure()).counts.actions).toBe(1);
        expect(
          (await scanModerationActions(database, { phase: 'actions' }, 500)).findings
            .filter((finding) => finding.entityId === block.id)
            .map((finding) => finding.anomalyType)
            .sort(),
        ).toEqual(['moderation_action_attempt_missing', 'moderation_action_report_mismatch']);
      } finally {
        await corrupt(async (connection) => {
          await connection
            .updateTable('moderation.moderation_actions')
            .set({
              target_pair_low_user_id: pair.userLowId,
              target_pair_high_user_id: pair.userHighId,
            })
            .where('id', '=', block.id)
            .execute();
        });
      }
      await corrupt(async (connection) => {
        await connection
          .updateTable('moderation.moderation_actions')
          .set({ target_user_id: photo.reporter })
          .where('command_id', '=', id)
          .execute();
      });
      try {
        expect((await store.measure()).counts.actions).toBe(1);
        expect(
          (await scanModerationActions(database, { phase: 'actions' }, 500)).findings.map(
            (finding) => finding.anomalyType,
          ),
        ).toEqual(['moderation_action_report_mismatch']);
      } finally {
        await corrupt(async (connection) => {
          await connection
            .updateTable('moderation.moderation_actions')
            .set({ target_user_id: review.target })
            .where('command_id', '=', id)
            .execute();
        });
      }
      expect(Object.values((await store.measure()).counts)).toEqual(
        Array.from({ length: 10 }, () => 0),
      );
    });
  },
);
