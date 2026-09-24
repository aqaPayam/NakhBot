import { createHash, randomUUID } from 'node:crypto';

import type {
  CaptureReportedMessagesResult,
  ChatRetentionStore,
  CleanupChatResult,
} from '@nakh/application';
import type { CaptureReportedMessagesCommand, CleanupChatCommand } from '@nakh/contracts';
import { ApplicationError, planChatMessageCleanup } from '@nakh/domain';
import { sql, type Selectable } from 'kysely';

import type { ChatMessageTable, NakhDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type MessageRow = Readonly<
  Pick<
    Selectable<ChatMessageTable>,
    | 'id'
    | 'chat_session_id'
    | 'sender_user_id'
    | 'message_type'
    | 'text'
    | 'predefined_question_id'
    | 'predefined_answer_id'
    | 'system_arguments'
    | 'sequence_number'
    | 'created_at'
  >
>;

type SnapshotRequest = Readonly<{
  report_id: string;
  chat_session_id: string;
  original_message_id: string;
  captured_at: Date | null;
}>;

function unavailable(): never {
  throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
}

function validateIds(values: readonly string[]): void {
  if (values.length < 1 || values.length > 100 || values.some((value) => !UUID.test(value)))
    throw new ApplicationError('invalid_request', 'error.chat.snapshot_invalid', 400);
}

function snapshotContent(message: MessageRow): Readonly<Record<string, unknown>> {
  switch (message.message_type) {
    case 'predefined_question':
      if (message.predefined_question_id === null) unavailable();
      return { predefinedQuestionId: message.predefined_question_id };
    case 'predefined_answer':
      if (message.predefined_answer_id === null) unavailable();
      return { predefinedAnswerId: message.predefined_answer_id };
    case 'text':
      if (message.text === null) unavailable();
      return { text: message.text };
    case 'system':
      if (message.text === null || message.system_arguments === null) unavailable();
      return { localizationKey: message.text, arguments: message.system_arguments };
  }
}

function snapshotDigest(
  request: SnapshotRequest,
  message: MessageRow,
  content: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        reportId: request.report_id,
        chatSessionId: request.chat_session_id,
        originalMessageId: message.id,
        senderUserId: message.sender_user_id,
        messageType: message.message_type,
        content,
        originalCreatedAt: message.created_at.toISOString(),
      }),
    )
    .digest('hex');
}

async function captureSnapshot(
  database: NakhDatabase,
  request: SnapshotRequest,
  message: MessageRow,
): Promise<boolean> {
  const content = snapshotContent(message);
  const integrity = snapshotDigest(request, message, content);
  const inserted = await database
    .insertInto('chat.chat_message_snapshots')
    .values({
      id: randomUUID(),
      report_id: request.report_id,
      chat_session_id: request.chat_session_id,
      original_message_id: message.id,
      sender_user_id: message.sender_user_id,
      message_type: message.message_type,
      content,
      // Preserve PostgreSQL microseconds instead of round-tripping through JavaScript Date.
      original_created_at: sql<Date>`(
        SELECT created_at
        FROM chat.chat_messages
        WHERE id = ${message.id} AND chat_session_id = ${message.chat_session_id}
      )`,
      integrity_sha256: integrity,
    })
    .onConflict((conflict) => conflict.columns(['report_id', 'original_message_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted === undefined) {
    const existing = await database
      .selectFrom('chat.chat_message_snapshots')
      .select(['chat_session_id', 'integrity_sha256'])
      .where('report_id', '=', request.report_id)
      .where('original_message_id', '=', message.id)
      .executeTakeFirstOrThrow();
    if (
      existing.chat_session_id !== request.chat_session_id ||
      existing.integrity_sha256 !== integrity
    )
      throw new ApplicationError('idempotency_conflict', 'error.chat.snapshot_conflict', 409);
  }
  await database
    .updateTable('chat.chat_message_snapshot_requests')
    .set((expression) => ({
      captured_at: sql<Date>`clock_timestamp()`,
      version: expression('version', '+', 1),
    }))
    .where('report_id', '=', request.report_id)
    .where('original_message_id', '=', message.id)
    .where('captured_at', 'is', null)
    .execute();
  return inserted !== undefined;
}

/** Restricted report-evidence capture and bounded newest-50 live-message cleanup. */
export class PostgresChatRetentionStore implements ChatRetentionStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async captureReportedMessages(
    command: CaptureReportedMessagesCommand,
  ): Promise<CaptureReportedMessagesResult> {
    const { reportId, chatSessionId, messageIds } = command.data;
    validateIds([reportId, chatSessionId, ...messageIds]);
    if (new Set(messageIds).size !== messageIds.length)
      throw new ApplicationError('invalid_request', 'error.chat.snapshot_invalid', 400);
    return this.database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom('chat.chat_sessions')
        .select('id')
        .where('id', '=', chatSessionId)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) unavailable();

      const prior = await transaction
        .selectFrom('chat.chat_message_snapshots')
        .select(['original_message_id', 'chat_session_id'])
        .where('report_id', '=', reportId)
        .where('original_message_id', 'in', messageIds)
        .execute();
      if (prior.some((snapshot) => snapshot.chat_session_id !== chatSessionId))
        throw new ApplicationError('idempotency_conflict', 'error.chat.snapshot_conflict', 409);
      if (prior.length === messageIds.length)
        return { reportId, chatSessionId, capturedMessageIds: messageIds, replayed: true };

      const priorIds = new Set(prior.map((snapshot) => snapshot.original_message_id));
      const missingIds = messageIds.filter((messageId) => !priorIds.has(messageId));
      const messages = await transaction
        .selectFrom('chat.chat_messages')
        .selectAll()
        .where('chat_session_id', '=', chatSessionId)
        .where('id', 'in', missingIds)
        .orderBy('id')
        .forUpdate()
        .execute();
      if (messages.length !== missingIds.length) unavailable();
      const byId = new Map(messages.map((message) => [message.id, message]));
      for (const messageId of missingIds) {
        const message = byId.get(messageId);
        if (message === undefined) unavailable();
        await transaction
          .insertInto('chat.chat_message_snapshot_requests')
          .values({
            report_id: reportId,
            chat_session_id: chatSessionId,
            original_message_id: messageId,
            captured_at: null,
          })
          .onConflict((conflict) =>
            conflict.columns(['report_id', 'original_message_id']).doNothing(),
          )
          .execute();
        await captureSnapshot(
          transaction,
          {
            report_id: reportId,
            chat_session_id: chatSessionId,
            original_message_id: messageId,
            captured_at: null,
          },
          message,
        );
      }
      return { reportId, chatSessionId, capturedMessageIds: messageIds, replayed: false };
    });
  }

  public async cleanupChat(command: CleanupChatCommand): Promise<CleanupChatResult> {
    const { chatSessionId, deleteBatchSize } = command.data;
    validateIds([chatSessionId]);
    if (!Number.isInteger(deleteBatchSize) || deleteBatchSize < 1 || deleteBatchSize > 500)
      throw new ApplicationError('invalid_request', 'error.chat.cleanup_batch_invalid', 400);
    return this.database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom('chat.chat_sessions')
        .select('id')
        .where('id', '=', chatSessionId)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) unavailable();
      const messages = await transaction
        .selectFrom('chat.chat_messages')
        .selectAll()
        .where('chat_session_id', '=', chatSessionId)
        .orderBy('sequence_number', 'desc')
        .limit(50 + deleteBatchSize)
        .forUpdate()
        .execute();
      const ids = messages.map(({ id }) => id);
      const requests =
        ids.length === 0
          ? []
          : await transaction
              .selectFrom('chat.chat_message_snapshot_requests')
              .select(['report_id', 'chat_session_id', 'original_message_id', 'captured_at'])
              .where('chat_session_id', '=', chatSessionId)
              .where('original_message_id', 'in', ids)
              .execute();
      const snapshots =
        ids.length === 0
          ? []
          : await transaction
              .selectFrom('chat.chat_message_snapshots')
              .select(['report_id', 'original_message_id'])
              .where('chat_session_id', '=', chatSessionId)
              .where('original_message_id', 'in', ids)
              .execute();
      const snapshotKeys = new Set(
        snapshots.map((snapshot) => `${snapshot.report_id}:${snapshot.original_message_id}`),
      );
      const requestsByMessage = new Map<string, SnapshotRequest[]>();
      for (const request of requests) {
        const owned = requestsByMessage.get(request.original_message_id) ?? [];
        owned.push(request);
        requestsByMessage.set(request.original_message_id, owned);
      }
      const candidates = messages.map((message) => {
        const owned = requestsByMessage.get(message.id) ?? [];
        return {
          messageId: message.id,
          sequenceNumber: BigInt(message.sequence_number),
          snapshotRequired: owned.length > 0,
          snapshotCaptured:
            owned.length > 0 &&
            owned.every((request) =>
              snapshotKeys.has(`${request.report_id}:${request.original_message_id}`),
            ),
        };
      });
      let plan = planChatMessageCleanup(candidates, deleteBatchSize);
      let snapshotCount = 0;
      for (const messageId of plan.deferredMessageIds) {
        const message = messages.find((candidate) => candidate.id === messageId);
        if (message === undefined) unavailable();
        for (const request of requestsByMessage.get(messageId) ?? [])
          if (await captureSnapshot(transaction, request, message)) snapshotCount += 1;
      }
      if (plan.deferredMessageIds.length > 0) {
        const captured = new Set(plan.deferredMessageIds);
        plan = planChatMessageCleanup(
          candidates.map((candidate) =>
            captured.has(candidate.messageId)
              ? { ...candidate, snapshotCaptured: true }
              : candidate,
          ),
          deleteBatchSize,
        );
      }
      if (plan.deleteMessageIds.length > 0)
        await transaction
          .deleteFrom('chat.chat_messages')
          .where('chat_session_id', '=', chatSessionId)
          .where('id', 'in', plan.deleteMessageIds)
          .execute();

      const remaining = await transaction
        .selectFrom('chat.chat_messages')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('chat_session_id', '=', chatSessionId)
        .executeTakeFirstOrThrow();
      const retainedSequence = messages.at(49)?.sequence_number ?? messages.at(-1)?.sequence_number;
      const checkpoint = await transaction
        .selectFrom('chat.chat_cleanup_checkpoints')
        .select(['deleted_message_count', 'version'])
        .where('chat_session_id', '=', chatSessionId)
        .executeTakeFirst();
      if (checkpoint === undefined)
        await transaction
          .insertInto('chat.chat_cleanup_checkpoints')
          .values({
            chat_session_id: chatSessionId,
            last_retained_sequence_number: retainedSequence ?? null,
            deleted_message_count: String(plan.deleteMessageIds.length),
            last_cleaned_at: sql<Date>`clock_timestamp()`,
          })
          .execute();
      else
        await transaction
          .updateTable('chat.chat_cleanup_checkpoints')
          .set({
            last_retained_sequence_number: retainedSequence ?? null,
            deleted_message_count: String(
              BigInt(checkpoint.deleted_message_count) + BigInt(plan.deleteMessageIds.length),
            ),
            last_cleaned_at: sql<Date>`clock_timestamp()`,
            version: checkpoint.version + 1,
          })
          .where('chat_session_id', '=', chatSessionId)
          .where('version', '=', checkpoint.version)
          .executeTakeFirstOrThrow();
      const retainedCount = Number(remaining.count);
      return {
        chatSessionId,
        retainedCount,
        snapshotCount,
        deletedCount: plan.deleteMessageIds.length,
        hasMore: retainedCount > 50,
      };
    });
  }

  public async findCleanupCandidates(limit: number): Promise<readonly string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApplicationError('invalid_request', 'error.chat.cleanup_batch_invalid', 400);
    const result = await sql<{ chat_session_id: string }>`
      SELECT chat_session_id
      FROM chat.chat_messages
      GROUP BY chat_session_id
      HAVING count(*) > 50
      ORDER BY min(created_at), chat_session_id
      LIMIT ${limit}
    `.execute(this.database);
    return result.rows.map(({ chat_session_id }) => chat_session_id);
  }
}
