import { NOTIFICATION_DELIVERY_MAX_ATTEMPTS } from '@nakh/domain';
import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';

export type ChatOperationalHealth = Readonly<{
  dueDeliveryCount: number;
  dueDeliveryOldestAgeSeconds: number;
  expiredCallLeaseCount: number;
  expiredCallLeaseOldestAgeSeconds: number;
  cleanupBacklogSessionCount: number;
  cleanupBacklogMessageCount: number;
  cleanupBacklogOldestAgeSeconds: number;
  pendingSnapshotCount: number;
  pendingSnapshotOldestAgeSeconds: number;
  participantMismatchCount: number;
  sequenceIntegrityCount: number;
  deliveryIntegrityCount: number;
}>;

type BacklogRow = Readonly<{ count: string; oldestAgeSeconds: string }>;
type CleanupRow = Readonly<{
  sessionCount: string;
  messageCount: string;
  oldestAgeSeconds: string;
}>;
type IntegrityRow = Readonly<{
  participantMismatchCount: string;
  sequenceIntegrityCount: string;
  deliveryIntegrityCount: string;
}>;

function finiteNonnegative(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`Invalid aggregate M6 operational metric: ${field}.`);
  return parsed;
}

/** Reads aggregate M6 health only; no identity, message, snapshot, or provider fact leaves it. */
export class PostgresChatOperationalMetricsStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async measure(): Promise<ChatOperationalHealth> {
    const [due, expiredCalls, cleanup, snapshots, integrity] = await Promise.all([
      sql<BacklogRow>`
        SELECT count(*)::text AS count,
          COALESCE(greatest(0,
            extract(epoch FROM clock_timestamp() - min(delivery.next_attempt_at))), 0)::text
            AS "oldestAgeSeconds"
        FROM notification.notification_deliveries delivery
        JOIN notification.notifications notification ON notification.id = delivery.notification_id
        WHERE notification.notification_type IN ('new_chat_message','chat_closed')
          AND delivery.status IN ('pending','failed_retryable')
          AND delivery.provider_progress = 'not_started'
          AND delivery.attempt_number < ${NOTIFICATION_DELIVERY_MAX_ATTEMPTS}
          AND delivery.next_attempt_at <= clock_timestamp()
      `.execute(this.database),
      sql<BacklogRow>`
        SELECT count(*)::text AS count,
          COALESCE(greatest(0,
            extract(epoch FROM clock_timestamp() - min(delivery.lease_expires_at))), 0)::text
            AS "oldestAgeSeconds"
        FROM notification.notification_deliveries delivery
        JOIN notification.notifications notification ON notification.id = delivery.notification_id
        WHERE notification.notification_type IN ('new_chat_message','chat_closed')
          AND delivery.status IN ('pending','failed_retryable')
          AND delivery.provider_progress = 'call_started'
          AND delivery.lease_expires_at <= clock_timestamp()
      `.execute(this.database),
      sql<CleanupRow>`
        WITH session_backlog AS (
          SELECT message.chat_session_id, count(*) - 50 AS excess,
            min(message.created_at) AS oldest
          FROM chat.chat_messages message
          GROUP BY message.chat_session_id
          HAVING count(*) > 50
        )
        SELECT count(*)::text AS "sessionCount",
          COALESCE(sum(excess), 0)::text AS "messageCount",
          COALESCE(greatest(0,
            extract(epoch FROM clock_timestamp() - min(oldest))), 0)::text
            AS "oldestAgeSeconds"
        FROM session_backlog
      `.execute(this.database),
      sql<BacklogRow>`
        SELECT count(*)::text AS count,
          COALESCE(greatest(0,
            extract(epoch FROM clock_timestamp() - min(request.requested_at))), 0)::text
            AS "oldestAgeSeconds"
        FROM chat.chat_message_snapshot_requests request
        WHERE request.captured_at IS NULL
      `.execute(this.database),
      sql<IntegrityRow>`
        WITH latest_run AS (
          SELECT id FROM billing.reconciliation_runs
          WHERE run_type = 'chat'
          ORDER BY started_at DESC, id DESC LIMIT 1
        )
        SELECT
          count(*) FILTER (
            WHERE anomaly.anomaly_type = 'chat_participant_set_drift'
          )::text AS "participantMismatchCount",
          count(*) FILTER (
            WHERE anomaly.anomaly_type IN (
              'chat_sequence_allocator_drift','chat_read_cursor_out_of_bounds',
              'chat_message_sequence_unallocated'
            )
          )::text AS "sequenceIntegrityCount",
          count(*) FILTER (
            WHERE anomaly.anomaly_type IN (
              'chat_notification_delivery_state_invalid',
              'chat_notification_delivery_call_ambiguous',
              'chat_unmatch_notification_cardinality'
            )
          )::text AS "deliveryIntegrityCount"
        FROM latest_run
        LEFT JOIN billing.reconciliation_anomalies anomaly ON anomaly.run_id = latest_run.id
      `.execute(this.database),
    ]);
    const dueRow = due.rows[0]!;
    const expiredRow = expiredCalls.rows[0]!;
    const cleanupRow = cleanup.rows[0]!;
    const snapshotRow = snapshots.rows[0]!;
    const integrityRow = integrity.rows[0] ?? {
      participantMismatchCount: '0',
      sequenceIntegrityCount: '0',
      deliveryIntegrityCount: '0',
    };
    return {
      dueDeliveryCount: finiteNonnegative(dueRow.count, 'dueDeliveryCount'),
      dueDeliveryOldestAgeSeconds: finiteNonnegative(
        dueRow.oldestAgeSeconds,
        'dueDeliveryOldestAgeSeconds',
      ),
      expiredCallLeaseCount: finiteNonnegative(expiredRow.count, 'expiredCallLeaseCount'),
      expiredCallLeaseOldestAgeSeconds: finiteNonnegative(
        expiredRow.oldestAgeSeconds,
        'expiredCallLeaseOldestAgeSeconds',
      ),
      cleanupBacklogSessionCount: finiteNonnegative(
        cleanupRow.sessionCount,
        'cleanupBacklogSessionCount',
      ),
      cleanupBacklogMessageCount: finiteNonnegative(
        cleanupRow.messageCount,
        'cleanupBacklogMessageCount',
      ),
      cleanupBacklogOldestAgeSeconds: finiteNonnegative(
        cleanupRow.oldestAgeSeconds,
        'cleanupBacklogOldestAgeSeconds',
      ),
      pendingSnapshotCount: finiteNonnegative(snapshotRow.count, 'pendingSnapshotCount'),
      pendingSnapshotOldestAgeSeconds: finiteNonnegative(
        snapshotRow.oldestAgeSeconds,
        'pendingSnapshotOldestAgeSeconds',
      ),
      participantMismatchCount: finiteNonnegative(
        integrityRow.participantMismatchCount,
        'participantMismatchCount',
      ),
      sequenceIntegrityCount: finiteNonnegative(
        integrityRow.sequenceIntegrityCount,
        'sequenceIntegrityCount',
      ),
      deliveryIntegrityCount: finiteNonnegative(
        integrityRow.deliveryIntegrityCount,
        'deliveryIntegrityCount',
      ),
    };
  }
}
