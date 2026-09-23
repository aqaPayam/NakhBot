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

export type M5QueryPlanInput = Readonly<{
  senderUserId: string;
  receiverUserId: string;
  afterCreatedAt: Date;
  afterPendingNakhId: string;
  afterSentAt: Date;
  afterNakhId: string;
  reconciliationCursor: string;
}>;

/** Keeps synthetic high-cardinality fixture writes and trigger bypass on one isolated session. */
export async function withM5SyntheticPlanSession<T>(
  database: NakhDatabase,
  work: (connection: NakhDatabase) => Promise<T>,
): Promise<T> {
  return database.connection().execute(async (connection) => {
    await sql`SET session_replication_role = replica`.execute(connection);
    try {
      return await work(connection);
    } finally {
      await sql`SET session_replication_role = origin`.execute(connection);
    }
  });
}

/** Runs the exact bounded M5 operational reads under PostgreSQL plan instrumentation. */
export async function explainM5Queries(
  database: NakhDatabase,
  input: M5QueryPlanInput,
): Promise<Readonly<Record<string, unknown>>> {
  const [
    flowLookup,
    settlementFifo,
    pendingSenderPage,
    receivedInbox,
    sentStatusPage,
    pendingExpiry,
    pendingReminder,
    deliveredExpiry,
    flowReconciliation,
    counterReconciliation,
    pendingReconciliation,
    deliveredReconciliation,
  ] = await Promise.all([
    explain(
      database,
      sql`SELECT id
          FROM nakh.nakh_flows
          WHERE sender_user_id = ${input.senderUserId}
            AND receiver_user_id = ${input.receiverUserId}
          LIMIT 1`,
    ),
    explain(
      database,
      sql`SELECT pending.id, pending.nakh_flow_id, pending.pending_payment_id
          FROM nakh.pending_nakhes pending
          JOIN billing.pending_payments intent ON intent.id = pending.pending_payment_id
          WHERE pending.sender_user_id = ${input.senderUserId}
            AND pending.status = 'pending_payment'
            AND intent.status = 'pending'
          ORDER BY pending.created_at, pending.id
          LIMIT 1`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM nakh.pending_nakhes
          WHERE sender_user_id = ${input.senderUserId}
            AND status = 'pending_payment'
            AND (created_at, id) < (${input.afterCreatedAt}, ${input.afterPendingNakhId}::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT 51`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM nakh.nakhes
          WHERE receiver_user_id = ${input.receiverUserId}
            AND (sent_at, id) < (${input.afterSentAt}, ${input.afterNakhId}::uuid)
          ORDER BY sent_at DESC, id DESC
          LIMIT 51`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM nakh.nakhes
          WHERE sender_user_id = ${input.senderUserId}
            AND (sent_at, id) < (${input.afterSentAt}, ${input.afterNakhId}::uuid)
          ORDER BY sent_at DESC, id DESC
          LIMIT 51`,
    ),
    explain(
      database,
      sql`SELECT id, sender_user_id
          FROM nakh.pending_nakhes
          WHERE status = 'pending_payment' AND expires_at <= clock_timestamp()
          ORDER BY expires_at, id
          LIMIT 250`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM nakh.pending_nakhes
          WHERE status = 'pending_payment' AND reminder_count < 6
            AND expires_at > clock_timestamp()
            AND COALESCE(last_reminder_at, created_at) + interval '48 hours' <= clock_timestamp()
          ORDER BY COALESCE(last_reminder_at, created_at), id
          LIMIT 250`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM nakh.nakhes
          WHERE status IN ('sent','seen') AND expires_at <= clock_timestamp()
          ORDER BY expires_at, id
          LIMIT 250`,
    ),
    explain(
      database,
      sql`SELECT flow.id
          FROM nakh.nakh_flows flow
          LEFT JOIN nakh.pending_nakhes pending ON pending.nakh_flow_id = flow.id
          LEFT JOIN nakh.nakhes delivered ON delivered.nakh_flow_id = flow.id
          WHERE flow.id > ${input.reconciliationCursor}::uuid
          GROUP BY flow.id
          ORDER BY flow.id
          LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT counter.user_id,
            (SELECT count(*) FROM nakh.pending_nakhes pending
              WHERE pending.sender_user_id = counter.user_id
                AND pending.status = 'pending_payment') AS actual_count
          FROM platform.user_counters counter
          WHERE counter.user_id > ${input.reconciliationCursor}::uuid
          ORDER BY counter.user_id
          LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT pending.id
          FROM nakh.pending_nakhes pending
          JOIN billing.pending_payments payment ON payment.id = pending.pending_payment_id
          WHERE pending.id > ${input.reconciliationCursor}::uuid
          ORDER BY pending.id
          LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT delivered.id,
            (SELECT count(*) FROM billing.credit_transactions credit
              WHERE credit.id = delivered.credit_transaction_id
                AND credit.nakh_id = delivered.id) AS credit_proof_count,
            (SELECT count(*) FROM nakh.nakh_status_history history
              WHERE history.nakh_id = delivered.id) AS history_count,
            (SELECT count(*) FROM notification.notifications notification
              WHERE notification.user_id = delivered.receiver_user_id
                AND notification.notification_type = 'nakh_received'
                AND notification.payload ->> 'nakhId' = delivered.id::text) AS notification_count,
            (SELECT count(*) FROM matching.matches match
              WHERE match.source = 'nakh_accept'
                AND match.source_nakh_id = delivered.id) AS accepted_match_count
          FROM nakh.nakhes delivered
          WHERE delivered.id > ${input.reconciliationCursor}::uuid
          ORDER BY delivered.id
          LIMIT 500`,
    ),
  ]);
  return {
    flowLookup,
    settlementFifo,
    pendingSenderPage,
    receivedInbox,
    sentStatusPage,
    pendingExpiry,
    pendingReminder,
    deliveredExpiry,
    flowReconciliation,
    counterReconciliation,
    pendingReconciliation,
    deliveredReconciliation,
  };
}

export async function analyzeM5QueryTables(database: NakhDatabase): Promise<void> {
  await sql`
    ANALYZE platform.user_counters, billing.pending_payments,
      nakh.nakh_flows, nakh.pending_nakhes, nakh.nakhes,
      nakh.nakh_status_history, billing.credit_transactions,
      notification.notifications, matching.matches
  `.execute(database);
}
