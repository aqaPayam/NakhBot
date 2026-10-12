import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { NakhReconciliationBatchResult, NakhReconciliationStore } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type Phase = 'flows' | 'counters' | 'pending' | 'delivered';
type Observations = Readonly<{ quotaDriftCount: number; fundingInvariantMismatchCount: number }>;
type Cursor = Readonly<{ phase: Phase; lastId?: string; observations?: Observations }>;
type EntityType = 'nakh_flow' | 'user_counter' | 'pending_nakh' | 'nakh';
type Finding = Readonly<{
  anomalyType: string;
  entityType: EntityType;
  entityId: string;
  disposition: 'repair_scheduled' | 'quarantined';
  safeDetail: Readonly<Record<string, string>>;
}>;
type ScanResult = Readonly<{
  findings: readonly Finding[];
  scannedCount: number;
  nextCursor: Cursor | undefined;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function invalidRequest(): never {
  throw new ApplicationError('invalid_request', 'error.nakh.reconciliation_invalid', 400);
}

function observationsFrom(value: unknown): Observations {
  if (value === undefined) return { quotaDriftCount: 0, fundingInvariantMismatchCount: 0 };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ApplicationError('conflict', 'error.nakh.reconciliation_cursor_invalid', 409);
  const stored = value as Readonly<Record<string, unknown>>;
  const quota = stored.quotaDriftCount,
    funding = stored.fundingInvariantMismatchCount;
  if (
    Object.keys(stored).length !== 2 ||
    typeof quota !== 'number' ||
    typeof funding !== 'number' ||
    !Number.isSafeInteger(quota) ||
    !Number.isSafeInteger(funding) ||
    quota < 0 ||
    funding < 0
  )
    throw new ApplicationError('conflict', 'error.nakh.reconciliation_cursor_invalid', 409);
  return { quotaDriftCount: quota, fundingInvariantMismatchCount: funding };
}

function cursorFrom(value: Readonly<Record<string, unknown>>): Cursor {
  const phase = value.phase;
  const lastId = value.lastId;
  if (
    (phase !== 'flows' && phase !== 'counters' && phase !== 'pending' && phase !== 'delivered') ||
    (lastId !== undefined && (typeof lastId !== 'string' || !UUID.test(lastId)))
  )
    throw new ApplicationError('conflict', 'error.nakh.reconciliation_cursor_invalid', 409);
  return {
    phase,
    ...(lastId === undefined ? {} : { lastId }),
    observations: observationsFrom(value.observations),
  };
}

function nextPage(
  phase: Phase,
  rows: readonly Readonly<{ id: string }>[],
  limit: number,
  nextPhase?: Phase,
): Cursor | undefined {
  const lastId = rows.at(-1)?.id;
  if (rows.length === limit && lastId !== undefined) return { phase, lastId };
  return nextPhase === undefined ? undefined : { phase: nextPhase };
}

/** Detects Nakh drift without rewriting product, billing, Match, or notification evidence. */
export class PostgresNakhReconciliationStore implements NakhReconciliationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async resumeOrStart(proposedRunId: string): Promise<string> {
    if (!UUID.test(proposedRunId)) invalidRequest();
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-reconciliation'))`.execute(transaction);
      const existing = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select('id')
        .where('run_type', '=', 'nakh')
        .where('status', '=', 'started')
        .orderBy('started_at', 'asc')
        .executeTakeFirst();
      if (existing !== undefined) return existing.id;
      await transaction
        .insertInto('billing.reconciliation_runs')
        .values({
          id: proposedRunId,
          run_type: 'nakh',
          status: 'started',
          cursor: { phase: 'flows', observations: observationsFrom(undefined) },
          failure_code: null,
          finished_at: null,
        })
        .execute();
      return proposedRunId;
    });
  }

  public async scanNextBatch(runId: string, limit: number): Promise<NakhReconciliationBatchResult> {
    if (!UUID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      invalidRequest();
    return this.database.transaction().execute(async (transaction) => {
      const run = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select(['id', 'run_type', 'status', 'cursor'])
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (run === undefined || run.run_type !== 'nakh')
        throw new ApplicationError('not_found', 'error.nakh.reconciliation_not_found', 404);
      if (run.status !== 'started')
        throw new ApplicationError('conflict', 'error.nakh.reconciliation_complete', 409);
      const cursor = cursorFrom(run.cursor);
      const batch = await this.scanPhase(transaction, cursor, limit);
      const previous = cursor.observations ?? observationsFrom(undefined);
      const observations = observationsFrom({
        quotaDriftCount:
          previous.quotaDriftCount +
          batch.findings.filter((finding) => finding.anomalyType === 'pending_nakh_counter_drift')
            .length,
        fundingInvariantMismatchCount:
          previous.fundingInvariantMismatchCount +
          new Set(
            batch.findings
              .filter((finding) =>
                [
                  'delivered_nakh_funding_proof_invalid',
                  'pending_nakh_payment_binding_invalid',
                  'pending_nakh_payment_status_drift',
                ].includes(finding.anomalyType),
              )
              .map((finding) => `${finding.entityType}:${finding.entityId}`),
          ).size,
      });

      let anomalyCount = 0;
      for (const finding of batch.findings) {
        const inserted = await transaction
          .insertInto('billing.reconciliation_anomalies')
          .values({
            id: randomUUID(),
            run_id: runId,
            anomaly_type: finding.anomalyType,
            entity_type: finding.entityType,
            entity_id: finding.entityId,
            disposition: finding.disposition,
            safe_detail: finding.safeDetail,
            idempotency_key: `nakh:${finding.anomalyType}:${finding.entityId}`,
          })
          .onConflict((conflict) => conflict.column('idempotency_key').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted !== undefined) anomalyCount += 1;
      }

      const completed = batch.nextCursor === undefined;
      await transaction
        .updateTable('billing.reconciliation_runs')
        .set({
          status: completed ? 'succeeded' : 'started',
          cursor: { ...(batch.nextCursor ?? { phase: 'delivered', complete: true }), observations },
          scanned_count: sql<string>`scanned_count + ${batch.scannedCount}`,
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
        scannedCount: batch.scannedCount,
        anomalyCount,
        completed,
      };
    });
  }

  private scanPhase(database: NakhDatabase, cursor: Cursor, limit: number): Promise<ScanResult> {
    switch (cursor.phase) {
      case 'flows':
        return this.scanFlows(database, cursor, limit);
      case 'counters':
        return this.scanCounters(database, cursor, limit);
      case 'pending':
        return this.scanPending(database, cursor, limit);
      case 'delivered':
        return this.scanDelivered(database, cursor, limit);
    }
  }

  private async scanFlows(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      flowShapeValid: boolean;
      pendingStatus: string | null;
      pendingShapeValid: boolean | null;
      pendingCount: number;
      deliveredCount: number;
    }>`
      SELECT flow.id,
        bool_and(flow.shape_valid) AS "flowShapeValid",
        max(pending.status) AS "pendingStatus",
        bool_and(pending.shape_valid) AS "pendingShapeValid",
        count(DISTINCT pending.id)::integer AS "pendingCount",
        count(DISTINCT delivered.id)::integer AS "deliveredCount"
      FROM nakh.flow_lifecycle_facts flow
      LEFT JOIN nakh.pending_nakh_lifecycle_facts pending ON pending.nakh_flow_id = flow.id
      LEFT JOIN nakh.nakh_lifecycle_facts delivered ON delivered.nakh_flow_id = flow.id
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR flow.id > ${cursor.lastId ?? null}::uuid)
      GROUP BY flow.id
      ORDER BY flow.id
      LIMIT ${limit}
    `.execute(database);
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      const valid =
        row.flowShapeValid &&
        row.pendingCount <= 1 &&
        row.deliveredCount <= 1 &&
        ((row.pendingCount === 0 && row.deliveredCount === 1) ||
          (row.pendingCount === 1 &&
            row.pendingShapeValid === true &&
            ((row.pendingStatus === 'paid_and_sent' && row.deliveredCount === 1) ||
              (row.pendingStatus !== 'paid_and_sent' && row.deliveredCount === 0))));
      if (!valid)
        findings.push({
          anomalyType: 'nakh_flow_lifecycle_shape_invalid',
          entityType: 'nakh_flow',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            pendingStatus: row.pendingStatus ?? 'missing',
            pendingCount: String(row.pendingCount),
            deliveredCount: String(row.deliveredCount),
          },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('flows', rows.rows, limit, 'counters'),
    };
  }

  private async scanCounters(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{ id: string; recordedCount: number; actualCount: number }>`
      SELECT counter.user_id AS id,
        counter.pending_nakh_count AS "recordedCount",
        (SELECT count(*)::integer
          FROM nakh.pending_nakhes pending
          WHERE pending.sender_user_id = counter.user_id
            AND pending.status = 'pending_payment') AS "actualCount"
      FROM platform.user_counters counter
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR counter.user_id > ${cursor.lastId ?? null}::uuid)
      ORDER BY counter.user_id
      LIMIT ${limit}
    `.execute(database);
    const findings = rows.rows.flatMap<Finding>((row) =>
      row.recordedCount === row.actualCount
        ? []
        : [
            {
              anomalyType: 'pending_nakh_counter_drift',
              entityType: 'user_counter',
              entityId: row.id,
              disposition: 'repair_scheduled',
              safeDetail: {
                recordedCount: String(row.recordedCount),
                actualCount: String(row.actualCount),
              },
            },
          ],
    );
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('counters', rows.rows, limit, 'pending'),
    };
  }

  private async scanPending(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      pendingStatus: string;
      senderUserId: string | null;
      pendingExpiresAt: Date | null;
      paymentUserId: string | null;
      paymentTargetType: string | null;
      paymentTargetId: string | null;
      paymentReason: string | null;
      paymentExpiresAt: Date | null;
      paymentStatus: string | null;
      boundClosure: boolean;
      terminalClosureValid: boolean;
      originalReferenceValid: boolean;
    }>`
      SELECT pending.id,
        pending.status AS "pendingStatus",
        pending.sender_user_id AS "senderUserId",
        pending.expires_at AS "pendingExpiresAt",
        payment.user_id AS "paymentUserId",
        payment.target_type AS "paymentTargetType",
        payment.target_id AS "paymentTargetId",
        payment.reason AS "paymentReason",
        payment.expires_at AS "paymentExpiresAt",
        payment.status AS "paymentStatus",
        nakh.original_pending_reference_valid(pending.id) AS "originalReferenceValid",
        CASE WHEN pending.status='closed_by_system' THEN billing.pending_nakh_has_bound_closure(pending.id)
          ELSE false END AS "boundClosure",
        CASE WHEN pending.status IN ('cancelled','expired','closed_by_system')
          THEN nakh.terminal_pending_closure_valid(pending) ELSE false END AS "terminalClosureValid"
      FROM nakh.pending_nakh_lifecycle_facts pending
      LEFT JOIN billing.pending_payments payment ON payment.id = pending.pending_payment_id
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR pending.id > ${cursor.lastId ?? null}::uuid)
      ORDER BY pending.id
      LIMIT ${limit}
    `.execute(database);
    const expectedPaymentStatus: Readonly<Record<string, string>> = {
      pending_payment: 'pending',
      paid_and_sent: 'paid',
      cancelled: 'cancelled',
      expired: 'expired',
      closed_by_system: 'expired',
    };
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      if (
        !row.originalReferenceValid ||
        row.senderUserId !== row.paymentUserId ||
        row.paymentTargetType !== 'pending_nakh' ||
        row.paymentTargetId !== row.id ||
        row.paymentReason !== 'send_nakh' ||
        row.pendingExpiresAt?.getTime() !== row.paymentExpiresAt?.getTime()
      )
        findings.push({
          anomalyType: 'pending_nakh_payment_binding_invalid',
          entityType: 'pending_nakh',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            pendingStatus: row.pendingStatus,
            paymentStatus: row.paymentStatus ?? 'missing',
          },
        });
      if (
        row.paymentStatus === null ||
        (['cancelled', 'expired', 'closed_by_system'].includes(row.pendingStatus)
          ? !row.terminalClosureValid ||
            (row.pendingStatus === 'closed_by_system' && !row.boundClosure)
          : expectedPaymentStatus[row.pendingStatus] !== row.paymentStatus)
      )
        findings.push({
          anomalyType: 'pending_nakh_payment_status_drift',
          entityType: 'pending_nakh',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            pendingStatus: row.pendingStatus,
            paymentStatus: row.paymentStatus ?? 'missing',
          },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('pending', rows.rows, limit, 'delivered'),
    };
  }

  private async scanDelivered(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      fundingType: string;
      status: string;
      version: number;
      creditProofCount: number;
      paymentProofCount: number;
      originalFundingLifeValid: boolean;
      originalFundingBindingValid: boolean;
      originalReferenceValid: boolean;
      historyCount: number;
      historyMinVersion: number | null;
      historyMaxVersion: number | null;
      historyLastStatus: string | null;
      notificationCount: number;
      acceptedMatchCount: number;
    }>`
      SELECT delivered.id,
        delivered.funding_type AS "fundingType",
        delivered.status,
        delivered.version,
        nakh.original_funded_scope_valid(delivered.id,delivered.nakh_flow_id,
          delivered.sender_user_id,delivered.receiver_user_id,delivered.funding_type,
          delivered.credit_transaction_id,delivered.payment_record_id) AS "originalFundingBindingValid",
        nakh.original_funding_scope_life_valid(delivered.id,delivered.nakh_flow_id,
          delivered.sender_user_id,delivered.receiver_user_id,delivered.funding_type,
          delivered.credit_transaction_id,delivered.payment_record_id) AS "originalFundingLifeValid",
        EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors anchor
          JOIN nakh.verified_original_flow_lives original_flow ON original_flow.id=delivered.nakh_flow_id
          WHERE anchor.id=delivered.id AND anchor.nakh_flow_id=delivered.nakh_flow_id
            AND anchor.sender_user_id=delivered.sender_user_id
            AND anchor.receiver_user_id=delivered.receiver_user_id
            AND anchor.sender_product_epoch=delivered.sender_product_epoch
            AND anchor.receiver_product_epoch=delivered.receiver_product_epoch
            AND original_flow.sender_product_epoch=delivered.sender_product_epoch
            AND original_flow.receiver_product_epoch=delivered.receiver_product_epoch)
          AS "originalReferenceValid",
        (SELECT count(*)::integer FROM billing.credit_transactions credit
          WHERE credit.id = delivered.credit_transaction_id
            AND credit.nakh_id = delivered.id
            AND credit.user_id = delivered.sender_user_id
            AND credit.transaction_type = 'spend_nakh'
            AND credit.amount = -2) AS "creditProofCount",
        (SELECT count(*)::integer FROM billing.payment_records payment
          WHERE payment.id = delivered.payment_record_id
            AND payment.user_id = delivered.sender_user_id
            AND payment.payment_type = 'pay_pending_action'
            AND payment.paid_action_reason = 'send_nakh'
            AND payment.status = 'paid'
            AND payment.stars_amount = 2) AS "paymentProofCount",
        delivered.history_count AS "historyCount",
        delivered.history_min_version AS "historyMinVersion",
        delivered.history_max_version AS "historyMaxVersion",
        delivered.history_last_status AS "historyLastStatus",
        delivered.notification_count AS "notificationCount",
        (SELECT count(*)::integer FROM matching.match_lifecycle_facts match
          WHERE match.source = 'nakh_accept'
            AND match.source_nakh_id = delivered.id) AS "acceptedMatchCount"
      FROM nakh.nakh_lifecycle_facts delivered
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR delivered.id > ${cursor.lastId ?? null}::uuid)
      ORDER BY delivered.id
      LIMIT ${limit}
    `.execute(database);
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      const fundingValid =
        row.originalFundingBindingValid &&
        row.originalFundingLifeValid &&
        row.originalReferenceValid &&
        (row.fundingType === 'credits'
          ? row.creditProofCount === 1 && row.paymentProofCount === 0
          : row.creditProofCount === 0 && row.paymentProofCount === 1);
      if (!fundingValid)
        findings.push({
          anomalyType: 'delivered_nakh_funding_proof_invalid',
          entityType: 'nakh',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            fundingType: row.fundingType,
            creditProofCount: String(row.creditProofCount),
            paymentProofCount: String(row.paymentProofCount),
            originalFundingLifeValid: String(row.originalFundingLifeValid),
            originalFundingBindingValid: String(row.originalFundingBindingValid),
            originalReferenceValid: String(row.originalReferenceValid),
          },
        });
      if (
        row.historyCount !== row.version ||
        row.historyMinVersion !== 1 ||
        row.historyMaxVersion !== row.version ||
        row.historyLastStatus !== row.status
      )
        findings.push({
          anomalyType: 'delivered_nakh_history_drift',
          entityType: 'nakh',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            status: row.status,
            version: String(row.version),
            historyCount: String(row.historyCount),
            historyLastStatus: row.historyLastStatus ?? 'missing',
          },
        });
      if (row.notificationCount !== 1)
        findings.push({
          anomalyType: 'delivered_nakh_notification_cardinality',
          entityType: 'nakh',
          entityId: row.id,
          disposition: row.notificationCount === 0 ? 'repair_scheduled' : 'quarantined',
          safeDetail: { notificationCount: String(row.notificationCount) },
        });
      const matchValid =
        row.status === 'accepted' ? row.acceptedMatchCount === 1 : row.acceptedMatchCount === 0;
      if (!matchValid)
        findings.push({
          anomalyType: 'accepted_nakh_match_cardinality',
          entityType: 'nakh',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { status: row.status, matchCount: String(row.acceptedMatchCount) },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('delivered', rows.rows, limit),
    };
  }
}
