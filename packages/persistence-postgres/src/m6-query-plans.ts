import { NOTIFICATION_DELIVERY_MAX_ATTEMPTS } from '@nakh/domain';
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

export type M6QueryPlanInput = Readonly<{
  chatSessionId: string;
  beforeSequenceNumber: string;
  reconciliationCursor: string;
}>;

/** Keeps synthetic high-cardinality fixture writes and trigger bypass on one isolated session. */
export async function withM6SyntheticPlanSession<T>(
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

/** Runs the bounded M6 hot-path and reconciliation reads under PostgreSQL instrumentation. */
export async function explainM6Queries(
  database: NakhDatabase,
  input: M6QueryPlanInput,
): Promise<Readonly<Record<string, unknown>>> {
  const [
    historyPage,
    sessionCleanup,
    cleanupCandidates,
    dueDeliveryClaim,
    expiredCallLease,
    pendingSnapshots,
    sessionReconciliation,
    messageReconciliation,
    unmatchReconciliation,
    deliveryReconciliation,
  ] = await Promise.all([
    explain(
      database,
      sql`SELECT id, sequence_number
          FROM chat.chat_messages
          WHERE chat_session_id = ${input.chatSessionId}
            AND sequence_number < ${input.beforeSequenceNumber}::bigint
          ORDER BY sequence_number DESC
          LIMIT 50`,
    ),
    explain(
      database,
      sql`SELECT id, sequence_number
          FROM chat.chat_messages
          WHERE chat_session_id = ${input.chatSessionId}
          ORDER BY sequence_number DESC
          LIMIT 550`,
    ),
    explain(
      database,
      sql`SELECT chat_session_id
          FROM chat.chat_messages
          GROUP BY chat_session_id
          HAVING count(*) > 50
          ORDER BY min(created_at), chat_session_id
          LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM notification.notification_deliveries
          WHERE channel = 'telegram'
            AND status IN ('pending','failed_retryable')
            AND provider_progress = 'not_started'
            AND attempt_number < ${NOTIFICATION_DELIVERY_MAX_ATTEMPTS}
            AND next_attempt_at <= clock_timestamp()
            AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
          ORDER BY next_attempt_at, id
          LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT id
          FROM notification.notification_deliveries
          WHERE status IN ('pending','failed_retryable')
            AND provider_progress = 'call_started'
            AND lease_expires_at <= clock_timestamp()
          ORDER BY lease_expires_at, id
          LIMIT 100`,
    ),
    explain(
      database,
      sql`SELECT report_id, original_message_id
          FROM chat.chat_message_snapshot_requests
          WHERE chat_session_id = ${input.chatSessionId}
            AND captured_at IS NULL
          ORDER BY original_message_id, report_id
          LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT id FROM chat.chat_sessions
          WHERE id > ${input.reconciliationCursor}::uuid
          ORDER BY id LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT id FROM chat.chat_messages
          WHERE id > ${input.reconciliationCursor}::uuid
          ORDER BY id LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT match_id AS id FROM matching.unmatch_records
          WHERE match_id > ${input.reconciliationCursor}::uuid
          ORDER BY match_id LIMIT 500`,
    ),
    explain(
      database,
      sql`SELECT delivery.id
          FROM notification.notification_deliveries delivery
          JOIN notification.notifications notification ON notification.id = delivery.notification_id
          WHERE notification.notification_type IN ('new_chat_message','chat_closed')
            AND delivery.id > ${input.reconciliationCursor}::uuid
          ORDER BY delivery.id LIMIT 500`,
    ),
  ]);
  return {
    historyPage,
    sessionCleanup,
    cleanupCandidates,
    dueDeliveryClaim,
    expiredCallLease,
    pendingSnapshots,
    sessionReconciliation,
    messageReconciliation,
    unmatchReconciliation,
    deliveryReconciliation,
  };
}

export async function analyzeM6QueryTables(database: NakhDatabase): Promise<void> {
  await sql`
    ANALYZE chat.chat_sessions, chat.chat_messages,
      chat.chat_message_snapshot_requests, matching.unmatch_records,
      notification.notifications, notification.notification_deliveries
  `.execute(database);
}
