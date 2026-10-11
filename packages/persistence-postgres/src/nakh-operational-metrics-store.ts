import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';

export type NakhOperationalHealth = Readonly<{
  settlementBacklogCount: number;
  settlementOldestAgeSeconds: number;
  paidUndeliveredCount: number;
  paidUndeliveredOldestAgeSeconds: number;
  quotaDriftCount: number;
  fundingInvariantMismatchCount: number;
}>;

type BacklogRow = Readonly<{ count: string; oldestAgeSeconds: string }>;
type IntegrityRow = Readonly<{
  quotaDriftCount: string;
  fundingInvariantMismatchCount: string;
  observationsValid: boolean;
}>;

function finiteNonnegative(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`Invalid aggregate M5 operational metric: ${field}.`);
  return parsed;
}

/** Reads aggregate operational health only; no identity, text, payment, or provider fact leaves it. */
export class PostgresNakhOperationalMetricsStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async measure(): Promise<NakhOperationalHealth> {
    const [settlement, paidUndelivered, integrity] = await Promise.all([
      sql<BacklogRow>`
        SELECT count(*)::text AS count,
          COALESCE(
            greatest(0, extract(epoch FROM clock_timestamp() - min(pending.created_at))),
            0
          )::text AS "oldestAgeSeconds"
        FROM nakh.pending_nakhes pending
        JOIN billing.pending_payments payment ON payment.id = pending.pending_payment_id
        WHERE pending.status = 'pending_payment'
          AND payment.status = 'pending'
      `.execute(this.database),
      sql<BacklogRow>`
        SELECT count(*)::text AS count,
          COALESCE(
            greatest(0, extract(epoch FROM clock_timestamp() - min(payment.paid_at))),
            0
          )::text AS "oldestAgeSeconds"
        FROM billing.payment_records payment
        JOIN billing.payment_fulfillments fulfillment
          ON fulfillment.payment_record_id = payment.id
        JOIN billing.pending_payments intent ON intent.id = payment.pending_payment_id
        JOIN nakh.pending_nakhes pending ON pending.id = intent.target_id
        WHERE payment.payment_type = 'pay_pending_action'
          AND payment.paid_action_reason = 'send_nakh'
          AND payment.status = 'paid'
          AND intent.target_type = 'pending_nakh'
          AND intent.status = 'paid'
          AND pending.status = 'pending_payment'
          AND fulfillment.state IN ('fulfillment_pending', 'fulfilling')
      `.execute(this.database),
      sql<IntegrityRow>`
        WITH latest_run AS (
          SELECT id, status, cursor
          FROM billing.reconciliation_runs
          WHERE run_type = 'nakh'
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        ), last_completed AS (
          SELECT id, status, cursor
          FROM billing.reconciliation_runs
          WHERE run_type='nakh' AND status='succeeded'
          ORDER BY started_at DESC, id DESC LIMIT 1
        ), candidates AS (
          SELECT * FROM latest_run
          UNION ALL
          SELECT * FROM last_completed WHERE id NOT IN (SELECT id FROM latest_run)
        ), observed AS (
          SELECT CASE WHEN candidate.cursor ? 'observations' THEN
            COALESCE(candidate.cursor->'observations'->>'quotaDriftCount','invalid')::bigint
            ELSE (SELECT count(*) FROM billing.reconciliation_anomalies anomaly
              WHERE anomaly.run_id=candidate.id AND anomaly.anomaly_type='pending_nakh_counter_drift')
            END AS quota,
            CASE WHEN candidate.cursor ? 'observations' THEN
              COALESCE(candidate.cursor->'observations'->>'fundingInvariantMismatchCount','invalid')::bigint
            ELSE (SELECT count(*) FROM billing.reconciliation_anomalies anomaly
              WHERE anomaly.run_id=candidate.id AND anomaly.anomaly_type='delivered_nakh_funding_proof_invalid')
            END AS funding,
            CASE WHEN candidate.cursor ? 'observations' THEN
              jsonb_typeof(candidate.cursor->'observations') = 'object'
              AND jsonb_typeof(candidate.cursor#>'{observations,quotaDriftCount}') = 'number'
              AND jsonb_typeof(candidate.cursor#>'{observations,fundingInvariantMismatchCount}') = 'number'
              AND candidate.cursor->'observations' = jsonb_build_object(
                'quotaDriftCount', candidate.cursor#>'{observations,quotaDriftCount}',
                'fundingInvariantMismatchCount', candidate.cursor#>'{observations,fundingInvariantMismatchCount}')
              ELSE true END AS schema_valid
          FROM candidates candidate
        )
        SELECT COALESCE(max(quota),0)::text AS "quotaDriftCount",
          COALESCE(max(funding),0)::text AS "fundingInvariantMismatchCount",
          COALESCE(bool_and(COALESCE(schema_valid, false)
            AND quota BETWEEN 0 AND 9007199254740991
            AND funding BETWEEN 0 AND 9007199254740991), true) AS "observationsValid"
        FROM observed
      `.execute(this.database),
    ]);
    const settlementRow = settlement.rows[0]!;
    const paidRow = paidUndelivered.rows[0]!;
    const integrityRow = integrity.rows[0] ?? {
      quotaDriftCount: '0',
      fundingInvariantMismatchCount: '0',
      observationsValid: true,
    };
    if (!integrityRow.observationsValid)
      throw new Error('Invalid aggregate M5 operational metric: reconciliation observations.');
    return {
      settlementBacklogCount: finiteNonnegative(settlementRow.count, 'settlementBacklogCount'),
      settlementOldestAgeSeconds: finiteNonnegative(
        settlementRow.oldestAgeSeconds,
        'settlementOldestAgeSeconds',
      ),
      paidUndeliveredCount: finiteNonnegative(paidRow.count, 'paidUndeliveredCount'),
      paidUndeliveredOldestAgeSeconds: finiteNonnegative(
        paidRow.oldestAgeSeconds,
        'paidUndeliveredOldestAgeSeconds',
      ),
      quotaDriftCount: finiteNonnegative(integrityRow.quotaDriftCount, 'quotaDriftCount'),
      fundingInvariantMismatchCount: finiteNonnegative(
        integrityRow.fundingInvariantMismatchCount,
        'fundingInvariantMismatchCount',
      ),
    };
  }
}
