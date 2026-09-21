import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';

async function explain(
  database: NakhDatabase,
  statement: ReturnType<typeof sql>,
): Promise<unknown> {
  const result = await sql<{ 'QUERY PLAN': unknown }>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}
  `.execute(database);
  return result.rows[0]?.['QUERY PLAN'];
}

/** Runs the exact bounded M4 operational reads under PostgreSQL plan instrumentation. */
export async function explainM4Queries(
  database: NakhDatabase,
  input: Readonly<{ userId: string; paymentRecordId: string }>,
): Promise<Readonly<Record<string, unknown>>> {
  const [fulfillments, refunds, providerEvents, unlocks, deliveries, payments] = await Promise.all([
    explain(
      database,
      sql`SELECT payment_record_id
          FROM billing.payment_fulfillments
          WHERE state IN ('receipt_recorded','fulfillment_pending')
            AND available_at <= clock_timestamp()
          ORDER BY available_at, payment_record_id LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM billing.refund_records
          WHERE status IN ('pending','failed_retryable')
            AND provider_progress = 'not_started'
            AND available_at <= clock_timestamp()
          ORDER BY available_at, id LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM billing.payment_provider_events
          WHERE payment_record_id = ${input.paymentRecordId}
          ORDER BY received_at, id LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM interaction.feature_unlocks
          WHERE payer_user_id = ${input.userId} AND status = 'active'
          ORDER BY unlocked_at DESC, id DESC LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM notification.notification_deliveries
          WHERE status IN ('pending','failed_retryable')
            AND next_attempt_at <= clock_timestamp()
          ORDER BY next_attempt_at, id LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM billing.payment_records
          WHERE status = 'pending' AND created_at <= clock_timestamp() - interval '5 minutes'
          ORDER BY created_at, id LIMIT 100`,
    ),
  ]);
  return { fulfillments, refunds, providerEvents, unlocks, deliveries, payments };
}

export async function analyzeM4QueryTables(database: NakhDatabase): Promise<void> {
  await sql`
    ANALYZE billing.payment_records, billing.payment_provider_events,
      billing.payment_fulfillments, billing.refund_records,
      interaction.feature_unlocks, notification.notification_deliveries
  `.execute(database);
}
