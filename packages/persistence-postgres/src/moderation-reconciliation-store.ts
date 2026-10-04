import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  MODERATION_RECONCILIATION_PHASES,
  type ModerationReconciliationStore,
  type ModerationReconciliationPhase,
  type ModerationReconciliationBatchResult,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

type Cursor = Readonly<{ phase: ModerationReconciliationPhase; lastId?: string }>;
type Finding = Readonly<{
  anomalyType: string;
  entityId: string;
  keyId: string;
  entityType: 'report';
  safeDetail: Readonly<Record<string, string>>;
}>;
type Scan = Readonly<{
  findings: readonly Finding[];
  scannedCount: number;
  nextCursor: Cursor | undefined;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function invalid(): never {
  throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
}
function cursorFrom(value: Readonly<Record<string, unknown>>): Cursor {
  if (
    Object.keys(value).some((key) => !['phase', 'lastId'].includes(key)) ||
    typeof value.phase !== 'string' ||
    !MODERATION_RECONCILIATION_PHASES.includes(value.phase as ModerationReconciliationPhase) ||
    (value.lastId !== undefined && (typeof value.lastId !== 'string' || !UUID.test(value.lastId)))
  )
    throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
  return {
    phase: value.phase as ModerationReconciliationPhase,
    ...(value.lastId === undefined ? {} : { lastId: value.lastId }),
  };
}
function nextPage(
  cursor: Cursor,
  rows: readonly Readonly<{ id: string }>[],
  limit: number,
): Cursor | undefined {
  const lastId = rows.at(-1)?.id;
  if (rows.length === limit && lastId !== undefined) return { phase: cursor.phase, lastId };
  const nextPhase =
    MODERATION_RECONCILIATION_PHASES[MODERATION_RECONCILIATION_PHASES.indexOf(cursor.phase) + 1];
  return nextPhase === undefined ? undefined : { phase: nextPhase };
}
/** Metadata only: never reads prose, ciphertext, snapshot payloads, or key material into memory. */
export class PostgresModerationReconciliationStore implements ModerationReconciliationStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async resumeOrStart(proposedRunId: string): Promise<string> {
    if (!UUID.test(proposedRunId)) invalid();
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-reconciliation', 0))`.execute(
        transaction,
      );
      const existing = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select('id')
        .where('run_type', '=', 'moderation')
        .where('status', '=', 'started')
        .orderBy('started_at')
        .orderBy('id')
        .executeTakeFirst();
      if (existing !== undefined) return existing.id;
      await transaction
        .insertInto('billing.reconciliation_runs')
        .values({
          id: proposedRunId,
          run_type: 'moderation',
          status: 'started',
          cursor: { phase: 'reports' },
          failure_code: null,
          finished_at: null,
        })
        .execute();
      return proposedRunId;
    });
  }
  public async scanNextBatch(
    runId: string,
    limit: number,
  ): Promise<ModerationReconciliationBatchResult> {
    if (!UUID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid();
    return this.database.transaction().execute(async (transaction) => {
      const run = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select(['run_type', 'status', 'cursor'])
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (run === undefined || run.run_type !== 'moderation')
        throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
      if (run.status !== 'started')
        throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
      const cursor = cursorFrom(run.cursor);
      const scan =
        cursor.phase === 'reports'
          ? await this.scanReports(transaction, cursor, limit)
          : await this.scanEvidence(transaction, cursor, limit);
      let anomalyCount = 0;
      for (const finding of scan.findings) {
        const inserted = await transaction
          .insertInto('billing.reconciliation_anomalies')
          .values({
            id: randomUUID(),
            run_id: runId,
            anomaly_type: finding.anomalyType,
            entity_type: finding.entityType,
            entity_id: finding.entityId,
            disposition: 'quarantined',
            safe_detail: finding.safeDetail,
            idempotency_key: `moderation:${finding.anomalyType}:${finding.keyId}`,
          })
          .onConflict((conflict) => conflict.column('idempotency_key').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted !== undefined) anomalyCount++;
      }
      const completed = scan.nextCursor === undefined;
      await transaction
        .updateTable('billing.reconciliation_runs')
        .set({
          cursor: scan.nextCursor ?? { phase: cursor.phase, complete: true },
          status: completed ? 'succeeded' : 'started',
          scanned_count: sql<string>`scanned_count + ${scan.scannedCount}`,
          anomaly_count: sql<string>`anomaly_count + ${anomalyCount}`,
          finished_at: completed ? sql<Date>`clock_timestamp()` : null,
          failure_code: null,
        })
        .where('id', '=', runId)
        .where('status', '=', 'started')
        .executeTakeFirstOrThrow();
      return {
        runId,
        phase: cursor.phase,
        scannedCount: scan.scannedCount,
        anomalyCount,
        completed,
      };
    });
  }
  private async scanReports(database: NakhDatabase, cursor: Cursor, limit: number): Promise<Scan> {
    const rows = (
      await sql<{ id: string; hasEvidence: boolean }>`
      SELECT report.id, EXISTS (SELECT 1 FROM moderation.report_evidence evidence
        WHERE evidence.report_id = report.id) AS "hasEvidence"
      FROM moderation.reports report
      WHERE ${cursor.lastId ?? null}::uuid IS NULL OR report.id > ${cursor.lastId ?? null}::uuid
      ORDER BY report.id LIMIT ${limit}
    `.execute(database)
    ).rows;
    return {
      scannedCount: rows.length,
      nextCursor: nextPage(cursor, rows, limit),
      findings: rows
        .filter((row) => !row.hasEvidence)
        .map((row) => ({
          anomalyType: 'report_evidence_missing',
          entityType: 'report' as const,
          entityId: row.id,
          keyId: row.id,
          safeDetail: {},
        })),
    };
  }
  private async scanEvidence(database: NakhDatabase, cursor: Cursor, limit: number): Promise<Scan> {
    const rows = (
      await sql<{
        id: string;
        reportId: string;
        evidenceType: string;
        hasCapture: boolean;
        hasRetainedPhoto: boolean;
      }>`
      SELECT evidence.id, evidence.report_id AS "reportId", evidence.evidence_type AS "evidenceType",
        CASE WHEN evidence.evidence_type = 'message' THEN EXISTS (
          SELECT 1 FROM chat.chat_message_snapshots snapshot WHERE snapshot.report_id = evidence.report_id
            AND snapshot.original_message_id = evidence.chat_message_id
        ) ELSE EXISTS (
          SELECT 1 FROM moderation.report_snapshots snapshot WHERE snapshot.report_evidence_id = evidence.id
            AND snapshot.report_id = evidence.report_id AND snapshot.snapshot_type = evidence.evidence_type
            AND snapshot.schema_version = 1 AND snapshot.encryption_key_version >= 1
            AND octet_length(snapshot.nonce) = 12 AND octet_length(snapshot.ciphertext) BETWEEN 17 AND 65536
            AND snapshot.content_sha256 ~ '^[0-9a-f]{64}$'
        ) END AS "hasCapture",
        evidence.evidence_type <> 'photo' OR EXISTS (
          SELECT 1 FROM media.report_photo_evidence_holds hold
          JOIN media.photo_variants variant ON variant.id = hold.variant_id AND variant.asset_id = hold.asset_id
          JOIN media.media_assets asset ON asset.id = hold.asset_id
          WHERE hold.report_evidence_id = evidence.id AND hold.photo_id = evidence.profile_photo_id
            AND variant.variant_type = 'thumbnail' AND variant.transformation_version = 1
            AND encode(variant.sha256, 'hex') = hold.content_sha256
            AND variant.storage_deleted_at IS NULL AND asset.storage_deleted_at IS NULL
        ) AS "hasRetainedPhoto"
      FROM moderation.report_evidence evidence
      WHERE ${cursor.lastId ?? null}::uuid IS NULL OR evidence.id > ${cursor.lastId ?? null}::uuid
      ORDER BY evidence.id LIMIT ${limit}
    `.execute(database)
    ).rows;
    const findings: Finding[] = [];
    for (const row of rows) {
      for (const anomalyType of [
        ...(!row.hasCapture ? ['report_capture_missing_or_invalid'] : []),
        ...(!row.hasRetainedPhoto ? ['report_photo_retention_invalid'] : []),
      ])
        findings.push({
          anomalyType,
          entityType: 'report',
          entityId: row.reportId,
          keyId: row.id,
          safeDetail: { evidenceType: row.evidenceType },
        });
    }
    return { scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit), findings };
  }
}
