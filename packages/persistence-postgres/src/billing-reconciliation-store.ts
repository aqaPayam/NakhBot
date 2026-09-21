import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type {
  BillingReconciliationBatchResult,
  BillingReconciliationStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type Phase = 'uncertain_refunds' | 'stuck_fulfillments';
type Cursor = Readonly<{ phase: Phase; lastId?: string }>;
type Finding = Readonly<{
  anomalyType: string;
  entityType: 'payment_record' | 'refund_record';
  entityId: string;
  disposition: 'repair_scheduled' | 'quarantined';
  safeDetail: Readonly<Record<string, string>>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function invalidRequest(): never {
  throw new ApplicationError('invalid_request', 'error.billing.reconciliation_invalid', 400);
}

function cursorFrom(value: Readonly<Record<string, unknown>>): Cursor {
  const phase = value.phase;
  const lastId = value.lastId;
  if (
    (phase !== 'uncertain_refunds' && phase !== 'stuck_fulfillments') ||
    (lastId !== undefined && (typeof lastId !== 'string' || !UUID.test(lastId)))
  )
    throw new ApplicationError('conflict', 'error.billing.reconciliation_cursor_invalid', 409);
  return { phase, ...(lastId === undefined ? {} : { lastId }) };
}

/** Append-only reconciliation findings; product and provider evidence are never rewritten here. */
export class PostgresBillingReconciliationStore implements BillingReconciliationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async resumeOrStart(proposedRunId: string): Promise<string> {
    if (!UUID.test(proposedRunId)) invalidRequest();
    return this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select('id')
        .where('run_type', '=', 'billing')
        .where('status', '=', 'started')
        .orderBy('started_at', 'asc')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (existing !== undefined) return existing.id;
      await transaction
        .insertInto('billing.reconciliation_runs')
        .values({
          id: proposedRunId,
          status: 'started',
          cursor: { phase: 'uncertain_refunds' },
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
  ): Promise<BillingReconciliationBatchResult> {
    if (!UUID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      invalidRequest();
    return this.database.transaction().execute(async (transaction) => {
      const run = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select(['id', 'status', 'cursor'])
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (run === undefined)
        throw new ApplicationError('not_found', 'error.billing.reconciliation_not_found', 404);
      if (run.status !== 'started')
        throw new ApplicationError('conflict', 'error.billing.reconciliation_complete', 409);
      const cursor = cursorFrom(run.cursor);
      const batch =
        cursor.phase === 'uncertain_refunds'
          ? await this.scanUncertainRefunds(transaction, cursor, limit)
          : await this.scanStuckFulfillments(transaction, cursor, limit);

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
            idempotency_key: `${finding.anomalyType}:${finding.entityId}`,
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
          cursor: batch.nextCursor ?? { phase: 'stuck_fulfillments', complete: true },
          scanned_count: sql<string>`scanned_count + ${batch.scannedCount}`,
          anomaly_count: sql<string>`anomaly_count + ${anomalyCount}`,
          finished_at: completed ? sql<Date>`transaction_timestamp()` : null,
          failure_code: null,
        })
        .where('id', '=', runId)
        .where('status', '=', 'started')
        .executeTakeFirstOrThrow();
      return {
        runId,
        scannedCount: batch.scannedCount,
        anomalyCount,
        completed,
      };
    });
  }

  private async scanUncertainRefunds(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<Readonly<{ findings: Finding[]; scannedCount: number; nextCursor?: Cursor }>> {
    let query = database
      .selectFrom('billing.refund_records')
      .select(['id', 'status', 'provider_progress', 'last_error_code'])
      .where('funding_type', '=', 'telegram_stars')
      .where('status', '=', 'failed_retryable')
      .where('provider_progress', '=', 'call_started')
      .orderBy('id', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked();
    if (cursor.lastId !== undefined) query = query.where('id', '>', cursor.lastId);
    const rows = await query.execute();
    const findings: Finding[] = rows.map((row) => ({
      anomalyType: 'stars_refund_outcome_uncertain',
      entityType: 'refund_record',
      entityId: row.id,
      disposition: 'quarantined',
      safeDetail: {
        status: row.status,
        providerProgress: row.provider_progress,
        errorCode: row.last_error_code ?? 'unknown_failure',
      },
    }));
    const last = rows.at(-1)?.id;
    return {
      findings,
      scannedCount: rows.length,
      nextCursor:
        rows.length === limit && last !== undefined
          ? { phase: 'uncertain_refunds', lastId: last }
          : { phase: 'stuck_fulfillments' },
    };
  }

  private async scanStuckFulfillments(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<Readonly<{ findings: Finding[]; scannedCount: number; nextCursor?: Cursor }>> {
    let query = database
      .selectFrom('billing.payment_records as payment')
      .leftJoin(
        'billing.payment_fulfillments as fulfillment',
        'fulfillment.payment_record_id',
        'payment.id',
      )
      .select([
        'payment.id',
        'fulfillment.payment_record_id as fulfillment_id',
        'fulfillment.state',
        'fulfillment.lease_expires_at',
      ])
      .where('payment.status', '=', 'paid')
      .where('payment.paid_at', '<=', sql<Date>`clock_timestamp() - interval '5 minutes'`)
      .where((expression) =>
        expression.or([
          expression('fulfillment.payment_record_id', 'is', null),
          expression('fulfillment.state', '=', 'receipt_recorded'),
          expression.and([
            expression('fulfillment.state', '=', 'fulfillment_pending'),
            expression('fulfillment.lease_expires_at', '<', sql<Date>`clock_timestamp()`),
          ]),
        ]),
      )
      .orderBy('payment.id', 'asc')
      .limit(limit)
      .forUpdate('payment')
      .skipLocked();
    if (cursor.lastId !== undefined) query = query.where('payment.id', '>', cursor.lastId);
    const rows = await query.execute();
    const findings: Finding[] = rows.map((row) => {
      const missing = row.fulfillment_id === null;
      return {
        anomalyType: missing ? 'paid_payment_missing_fulfillment' : 'payment_fulfillment_stuck',
        entityType: 'payment_record',
        entityId: row.id,
        disposition: missing ? 'quarantined' : 'repair_scheduled',
        safeDetail: {
          fulfillmentState: row.state ?? 'missing',
          leaseState:
            row.lease_expires_at === null || row.lease_expires_at === undefined
              ? 'unleased'
              : 'expired',
        },
      };
    });
    const last = rows.at(-1)?.id;
    return {
      findings,
      scannedCount: rows.length,
      ...(rows.length === limit && last !== undefined
        ? { nextCursor: { phase: 'stuck_fulfillments' as const, lastId: last } }
        : {}),
    };
  }
}
