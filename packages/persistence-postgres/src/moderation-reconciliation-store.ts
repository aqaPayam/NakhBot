import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
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
import {
  nextPage,
  type Cursor,
  type Finding,
  type Scan,
} from './moderation-reconciliation-scan.js';
import {
  scanModerationReviews,
  scanModerationActions,
  scanRestrictionEpisodes,
} from './moderation-review-reconciliation.js';
import {
  scanSupportThreads,
  scanAppeals,
  scanAdmins,
  scanAdminLogs,
  scanInternalBlocks,
} from './moderation-safety-reconciliation.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function invalid(): never {
  throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
}
function cursorFrom(value: Readonly<Record<string, unknown>>): Cursor {
  if (
    Object.keys(value).some((key) => !['phase', 'lastId', 'lastPairHighId'].includes(key)) ||
    typeof value.phase !== 'string' ||
    !MODERATION_RECONCILIATION_PHASES.includes(value.phase as ModerationReconciliationPhase) ||
    (value.lastId !== undefined &&
      (typeof value.lastId !== 'string' || !UUID.test(value.lastId))) ||
    (value.lastPairHighId !== undefined &&
      (typeof value.lastPairHighId !== 'string' || !UUID.test(value.lastPairHighId))) ||
    (value.phase !== 'internal_blocks' && value.lastPairHighId !== undefined) ||
    (value.phase === 'internal_blocks' &&
      (value.lastId === undefined) !== (value.lastPairHighId === undefined)) ||
    (typeof value.lastId === 'string' &&
      typeof value.lastPairHighId === 'string' &&
      value.lastId.toLowerCase() >= value.lastPairHighId.toLowerCase())
  )
    throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
  return {
    phase: value.phase as ModerationReconciliationPhase,
    ...(value.lastId === undefined ? {} : { lastId: value.lastId }),
    ...(value.lastPairHighId === undefined ? {} : { lastPairHighId: value.lastPairHighId }),
  };
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
      const scan = await this.scanPhase(transaction, cursor, limit);
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
  private scanPhase(database: NakhDatabase, cursor: Cursor, limit: number): Promise<Scan> {
    switch (cursor.phase) {
      case 'reports':
        return this.scanReports(database, cursor, limit);
      case 'evidence':
        return this.scanEvidence(database, cursor, limit);
      case 'reviews':
        return scanModerationReviews(database, cursor, limit);
      case 'actions':
        return scanModerationActions(database, cursor, limit);
      case 'episodes':
        return scanRestrictionEpisodes(database, cursor, limit);
      case 'support_threads':
        return scanSupportThreads(database, cursor, limit);
      case 'appeals':
        return scanAppeals(database, cursor, limit);
      case 'admins':
        return scanAdmins(database, cursor, limit);
      case 'admin_logs':
        return scanAdminLogs(database, cursor, limit);
      case 'internal_blocks':
        return scanInternalBlocks(database, cursor, limit);
    }
  }
  private async scanReports(database: NakhDatabase, cursor: Cursor, limit: number): Promise<Scan> {
    const rows = (
      await sql<{ id: string; hasEvidence: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.reports}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
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
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.evidence}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
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
