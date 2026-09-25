import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type {
  ChatReconciliationBatchResult,
  ChatReconciliationPhase,
  ChatReconciliationStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type Cursor = Readonly<{ phase: ChatReconciliationPhase; lastId?: string }>;
type EntityType = 'chat_session' | 'chat_message' | 'match' | 'notification_delivery';
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
const PHASES: readonly ChatReconciliationPhase[] = [
  'sessions',
  'messages',
  'unmatches',
  'deliveries',
];

function invalidRequest(): never {
  throw new ApplicationError('invalid_request', 'error.chat.reconciliation_invalid', 400);
}

function cursorFrom(value: Readonly<Record<string, unknown>>): Cursor {
  const phase = value.phase;
  const lastId = value.lastId;
  if (
    typeof phase !== 'string' ||
    !PHASES.includes(phase as ChatReconciliationPhase) ||
    (lastId !== undefined && (typeof lastId !== 'string' || !UUID.test(lastId)))
  )
    throw new ApplicationError('conflict', 'error.chat.reconciliation_cursor_invalid', 409);
  return {
    phase: phase as ChatReconciliationPhase,
    ...(lastId === undefined ? {} : { lastId }),
  };
}

function nextPage(
  phase: ChatReconciliationPhase,
  rows: readonly Readonly<{ id: string }>[],
  limit: number,
  nextPhase?: ChatReconciliationPhase,
): Cursor | undefined {
  const lastId = rows.at(-1)?.id;
  if (rows.length === limit && lastId !== undefined) return { phase, lastId };
  return nextPhase === undefined ? undefined : { phase: nextPhase };
}

/** Detects M6 chat drift without reading message text into application memory or logs. */
export class PostgresChatReconciliationStore implements ChatReconciliationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async resumeOrStart(proposedRunId: string): Promise<string> {
    if (!UUID.test(proposedRunId)) invalidRequest();
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('chat-reconciliation'))`.execute(transaction);
      const existing = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select('id')
        .where('run_type', '=', 'chat')
        .where('status', '=', 'started')
        .orderBy('started_at', 'asc')
        .executeTakeFirst();
      if (existing !== undefined) return existing.id;
      await transaction
        .insertInto('billing.reconciliation_runs')
        .values({
          id: proposedRunId,
          run_type: 'chat',
          status: 'started',
          cursor: { phase: 'sessions' },
          failure_code: null,
          finished_at: null,
        })
        .execute();
      return proposedRunId;
    });
  }

  public async scanNextBatch(runId: string, limit: number): Promise<ChatReconciliationBatchResult> {
    if (!UUID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      invalidRequest();
    return this.database.transaction().execute(async (transaction) => {
      const run = await transaction
        .selectFrom('billing.reconciliation_runs')
        .select(['id', 'run_type', 'status', 'cursor'])
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (run === undefined || run.run_type !== 'chat')
        throw new ApplicationError('not_found', 'error.chat.reconciliation_not_found', 404);
      if (run.status !== 'started')
        throw new ApplicationError('conflict', 'error.chat.reconciliation_complete', 409);
      const cursor = cursorFrom(run.cursor);
      const batch = await this.scanPhase(transaction, cursor, limit);

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
            idempotency_key: `chat:${finding.anomalyType}:${finding.entityId}`,
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
          cursor: batch.nextCursor ?? { phase: 'deliveries', complete: true },
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
      case 'sessions':
        return this.scanSessions(database, cursor, limit);
      case 'messages':
        return this.scanMessages(database, cursor, limit);
      case 'unmatches':
        return this.scanUnmatches(database, cursor, limit);
      case 'deliveries':
        return this.scanDeliveries(database, cursor, limit);
    }
  }

  private async scanSessions(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      status: string;
      matchStatus: string;
      nextSequenceNumber: string;
      expectedNextSequenceNumber: string;
      participantCount: number;
      participantMismatchCount: number;
      readBeyondCount: number;
      liveMessageCount: number;
    }>`
      SELECT session.id, session.status, match.status AS "matchStatus",
        session.next_sequence_number::text AS "nextSequenceNumber",
        (COALESCE(maximum.value, 0) + 1)::text AS "expectedNextSequenceNumber",
        (SELECT count(*)::integer FROM chat.chat_participants participant
          WHERE participant.chat_session_id = session.id) AS "participantCount",
        (
          SELECT count(*)::integer FROM (
            (SELECT participant.user_id FROM chat.chat_participants participant
              WHERE participant.chat_session_id = session.id
             EXCEPT
             SELECT expected.user_id FROM matching.match_participants expected
              WHERE expected.match_id = match.id)
            UNION ALL
            (SELECT expected.user_id FROM matching.match_participants expected
              WHERE expected.match_id = match.id
             EXCEPT
             SELECT participant.user_id FROM chat.chat_participants participant
              WHERE participant.chat_session_id = session.id)
          ) mismatch
        ) AS "participantMismatchCount",
        (SELECT count(*)::integer FROM chat.chat_participants participant
          WHERE participant.chat_session_id = session.id
            AND participant.last_read_sequence_number IS NOT NULL
            AND participant.last_read_sequence_number > COALESCE(maximum.value, 0))
          AS "readBeyondCount",
        (SELECT count(*)::integer FROM chat.chat_messages message
          WHERE message.chat_session_id = session.id) AS "liveMessageCount"
      FROM chat.chat_sessions session
      JOIN matching.matches match ON match.id = session.match_id
      LEFT JOIN LATERAL (
        SELECT max(message.sequence_number) AS value
        FROM chat.chat_messages message WHERE message.chat_session_id = session.id
      ) maximum ON true
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR session.id > ${cursor.lastId ?? null}::uuid)
      ORDER BY session.id
      LIMIT ${limit}
    `.execute(database);
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      if (row.participantCount !== 2 || row.participantMismatchCount !== 0)
        findings.push({
          anomalyType: 'chat_participant_set_drift',
          entityType: 'chat_session',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            participantCount: String(row.participantCount),
            mismatchCount: String(row.participantMismatchCount),
          },
        });
      if (row.nextSequenceNumber !== row.expectedNextSequenceNumber)
        findings.push({
          anomalyType: 'chat_sequence_allocator_drift',
          entityType: 'chat_session',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            nextSequenceNumber: row.nextSequenceNumber,
            expectedNextSequenceNumber: row.expectedNextSequenceNumber,
          },
        });
      if (row.readBeyondCount !== 0)
        findings.push({
          anomalyType: 'chat_read_cursor_out_of_bounds',
          entityType: 'chat_session',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { affectedCount: String(row.readBeyondCount) },
        });
      if (
        (row.status === 'active' && row.matchStatus !== 'active') ||
        (row.status === 'closed' && row.matchStatus === 'active')
      )
        findings.push({
          anomalyType: 'chat_match_lifecycle_drift',
          entityType: 'chat_session',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { sessionStatus: row.status, matchStatus: row.matchStatus },
        });
      if (row.liveMessageCount > 50)
        findings.push({
          anomalyType: 'chat_live_message_ceiling_exceeded',
          entityType: 'chat_session',
          entityId: row.id,
          disposition: 'repair_scheduled',
          safeDetail: { liveMessageCount: String(row.liveMessageCount) },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('sessions', rows.rows, limit, 'messages'),
    };
  }

  private async scanMessages(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      messageType: string;
      senderIsParticipant: boolean;
      payloadValid: boolean;
      sequenceAllocated: boolean;
    }>`
      SELECT message.id, message.message_type AS "messageType",
        (message.sender_user_id IS NULL OR EXISTS (
          SELECT 1 FROM chat.chat_participants participant
          WHERE participant.chat_session_id = message.chat_session_id
            AND participant.user_id = message.sender_user_id
        )) AS "senderIsParticipant",
        CASE message.message_type
          WHEN 'predefined_question' THEN message.sender_user_id IS NOT NULL
            AND message.predefined_question_id IS NOT NULL
            AND message.predefined_answer_id IS NULL AND message.text IS NULL
            AND message.system_arguments IS NULL
          WHEN 'predefined_answer' THEN message.sender_user_id IS NOT NULL
            AND message.predefined_question_id IS NULL
            AND message.predefined_answer_id IS NOT NULL AND message.text IS NULL
            AND message.system_arguments IS NULL
          WHEN 'text' THEN message.sender_user_id IS NOT NULL
            AND message.predefined_question_id IS NULL
            AND message.predefined_answer_id IS NULL AND message.text IS NOT NULL
            AND char_length(message.text) BETWEEN 1 AND 1000
            AND message.text = btrim(message.text) AND message.system_arguments IS NULL
          WHEN 'system' THEN message.sender_user_id IS NULL
            AND message.predefined_question_id IS NULL
            AND message.predefined_answer_id IS NULL
            AND message.text ~ '^[a-z][a-z0-9_.]{0,159}$'
            AND jsonb_typeof(message.system_arguments) = 'object'
            AND octet_length(message.system_arguments::text) <= 2048
          ELSE false
        END AS "payloadValid",
        message.sequence_number < session.next_sequence_number AS "sequenceAllocated"
      FROM chat.chat_messages message
      JOIN chat.chat_sessions session ON session.id = message.chat_session_id
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR message.id > ${cursor.lastId ?? null}::uuid)
      ORDER BY message.id
      LIMIT ${limit}
    `.execute(database);
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      if (!row.senderIsParticipant)
        findings.push({
          anomalyType: 'chat_message_sender_invalid',
          entityType: 'chat_message',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { messageType: row.messageType },
        });
      if (!row.payloadValid)
        findings.push({
          anomalyType: 'chat_message_payload_invalid',
          entityType: 'chat_message',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { messageType: row.messageType },
        });
      if (!row.sequenceAllocated)
        findings.push({
          anomalyType: 'chat_message_sequence_unallocated',
          entityType: 'chat_message',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { messageType: row.messageType },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('messages', rows.rows, limit, 'unmatches'),
    };
  }

  private async scanUnmatches(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      lifecycleValid: boolean;
      notificationCount: number;
    }>`
      SELECT record.match_id AS id,
        (match.status = 'unmatched' AND match.closed_at = record.unmatched_at
          AND pair.state = 'unmatched' AND pair.changed_at = record.unmatched_at
          AND session.status = 'closed' AND session.closed_reason = 'unmatch'
          AND session.closed_at = record.unmatched_at) AS "lifecycleValid",
        (SELECT count(*)::integer FROM notification.notifications notification
          WHERE notification.user_id = CASE
            WHEN record.actor_user_id = match.user_low_id THEN match.user_high_id
            ELSE match.user_low_id END
            AND notification.notification_type = 'chat_closed'
            AND notification.deduplication_key =
              'unmatch:' || match.id::text || ':' ||
              (CASE WHEN record.actor_user_id = match.user_low_id
                THEN match.user_high_id ELSE match.user_low_id END)::text
        ) AS "notificationCount"
      FROM matching.unmatch_records record
      JOIN matching.matches match ON match.id = record.match_id
      JOIN interaction.user_pair_states pair
        ON pair.user_low_id = match.user_low_id AND pair.user_high_id = match.user_high_id
      JOIN chat.chat_sessions session ON session.match_id = match.id
      WHERE (${cursor.lastId ?? null}::uuid IS NULL OR record.match_id > ${cursor.lastId ?? null}::uuid)
      ORDER BY record.match_id
      LIMIT ${limit}
    `.execute(database);
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      if (!row.lifecycleValid)
        findings.push({
          anomalyType: 'chat_unmatch_lifecycle_drift',
          entityType: 'match',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { lifecycleValid: 'false' },
        });
      if (row.notificationCount !== 1)
        findings.push({
          anomalyType: 'chat_unmatch_notification_cardinality',
          entityType: 'match',
          entityId: row.id,
          disposition: row.notificationCount === 0 ? 'repair_scheduled' : 'quarantined',
          safeDetail: { notificationCount: String(row.notificationCount) },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('unmatches', rows.rows, limit, 'deliveries'),
    };
  }

  private async scanDeliveries(
    database: NakhDatabase,
    cursor: Cursor,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await sql<{
      id: string;
      status: string;
      providerProgress: string;
      stateValid: boolean;
      leaseValid: boolean;
      expiredCallLease: boolean;
    }>`
      SELECT delivery.id, delivery.status,
        delivery.provider_progress AS "providerProgress",
        CASE delivery.status
          WHEN 'pending' THEN delivery.next_attempt_at IS NOT NULL
            AND delivery.sent_at IS NULL AND delivery.failed_at IS NULL
            AND delivery.failure_code IS NULL
          WHEN 'sent' THEN delivery.next_attempt_at IS NULL
            AND delivery.sent_at IS NOT NULL AND delivery.failed_at IS NULL
            AND delivery.failure_code IS NULL AND delivery.provider_progress = 'settled'
            AND delivery.provider_delivery_key IS NOT NULL
          WHEN 'failed_retryable' THEN delivery.next_attempt_at IS NOT NULL
            AND delivery.sent_at IS NULL AND delivery.failed_at IS NOT NULL
            AND delivery.failure_code IS NOT NULL
          WHEN 'failed_terminal' THEN delivery.next_attempt_at IS NULL
            AND delivery.sent_at IS NULL AND delivery.failed_at IS NOT NULL
            AND delivery.failure_code IS NOT NULL
            AND ((delivery.failure_code = 'ambiguous_result'
                AND delivery.provider_progress = 'ambiguous'
                AND delivery.quarantined_at IS NOT NULL)
              OR (delivery.failure_code <> 'ambiguous_result'
                AND delivery.provider_progress = 'settled'
                AND delivery.quarantined_at IS NULL))
          ELSE false
        END AS "stateValid",
        ((delivery.lease_owner IS NULL AND delivery.lease_expires_at IS NULL)
          OR (delivery.lease_owner IS NOT NULL AND delivery.lease_expires_at IS NOT NULL
            AND delivery.status IN ('pending','failed_retryable')
            AND delivery.fence_token > 0)) AS "leaseValid",
        (delivery.provider_progress = 'call_started'
          AND delivery.lease_expires_at < clock_timestamp()) AS "expiredCallLease"
      FROM notification.notification_deliveries delivery
      JOIN notification.notifications notification ON notification.id = delivery.notification_id
      WHERE notification.notification_type IN ('new_chat_message','chat_closed')
        AND (${cursor.lastId ?? null}::uuid IS NULL OR delivery.id > ${cursor.lastId ?? null}::uuid)
      ORDER BY delivery.id
      LIMIT ${limit}
    `.execute(database);
    const findings: Finding[] = [];
    for (const row of rows.rows) {
      if (!row.stateValid || !row.leaseValid)
        findings.push({
          anomalyType: 'chat_notification_delivery_state_invalid',
          entityType: 'notification_delivery',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: {
            status: row.status,
            providerProgress: row.providerProgress,
            stateValid: String(row.stateValid),
            leaseValid: String(row.leaseValid),
          },
        });
      if (row.expiredCallLease)
        findings.push({
          anomalyType: 'chat_notification_delivery_call_ambiguous',
          entityType: 'notification_delivery',
          entityId: row.id,
          disposition: 'quarantined',
          safeDetail: { status: row.status, providerProgress: row.providerProgress },
        });
    }
    return {
      findings,
      scannedCount: rows.rows.length,
      nextCursor: nextPage('deliveries', rows.rows, limit),
    };
  }
}
