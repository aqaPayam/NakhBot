import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  ChangeChatMuteWrite,
  ChatHistoryStore,
  ChatParticipantStateStore,
  MarkChatReadWrite,
  StoredChatPage,
} from '@nakh/application';
import type { ChatMessage, ChatMuteResult, ChatReadResult } from '@nakh/contracts';
import { ApplicationError, CHAT_VISIBLE_MESSAGE_LIMIT } from '@nakh/domain';

import { loadChatCapability } from './chat-store.js';
import type { NakhDatabase } from './database.js';

type StateWrite = MarkChatReadWrite | ChangeChatMuteWrite;
type StateResult = ChatReadResult | ChatMuteResult;

function unavailable(): never {
  throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
}

async function databaseTime(database: NakhDatabase): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  return result.rows[0]!.now;
}

function requestHash(write: StateWrite): string {
  const command = write.command;
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: command.schemaVersion,
        actor: command.actor,
        chatSessionId: write.chatSessionId,
        ...(command.commandType === 'chat.mark-read'
          ? { throughSequenceNumber: command.data.throughSequenceNumber }
          : { muted: command.data.muted, expectedVersion: command.data.expectedVersion }),
      }),
    )
    .digest('hex');
}

async function claimCommand<TResult extends StateResult>(
  database: NakhDatabase,
  write: StateWrite,
  occurredAt: Date,
): Promise<TResult | undefined> {
  const command = write.command;
  const hash = requestHash(write);
  const inserted = await database
    .insertInto('platform.idempotency_records')
    .values({
      id: command.commandId,
      actor_user_id: command.actor.userId,
      scope: command.commandType,
      idempotency_key: command.idempotencyKey,
      request_hash: hash,
      status: 'processing',
      response_json: null,
      expires_at: new Date(occurredAt.getTime() + 86_400_000),
      created_at: occurredAt,
      updated_at: occurredAt,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted !== undefined) return undefined;
  const existing = await database
    .selectFrom('platform.idempotency_records')
    .select(['request_hash', 'status', 'response_json'])
    .where('actor_user_id', '=', command.actor.userId)
    .where('scope', '=', command.commandType)
    .where('idempotency_key', '=', command.idempotencyKey)
    .executeTakeFirst();
  if (existing === undefined || existing.request_hash !== hash)
    throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
  if (existing.status !== 'completed' || existing.response_json === null)
    throw new ApplicationError('conflict', 'error.command.in_progress', 409);
  return { ...(existing.response_json as unknown as TResult), replayed: true };
}

async function completeCommand(
  database: NakhDatabase,
  write: StateWrite,
  result: StateResult,
  occurredAt: Date,
): Promise<void> {
  await database
    .updateTable('platform.idempotency_records')
    .set({ status: 'completed', response_json: result, updated_at: occurredAt })
    .where('id', '=', write.command.commandId)
    .executeTakeFirstOrThrow();
}

function toMessage(
  row: Readonly<{
    id: string;
    sender_user_id: string | null;
    message_type: 'predefined_question' | 'predefined_answer' | 'text' | 'system';
    text: string | null;
    predefined_question_id: string | null;
    predefined_answer_id: string | null;
    question_text_key: string | null;
    answer_question_id: string | null;
    answer_text_key: string | null;
    system_arguments: Readonly<Record<string, unknown>> | null;
    sequence_number: string;
    created_at: Date;
  }>,
  viewerUserId: string,
): ChatMessage {
  const base = {
    messageId: row.id,
    sequenceNumber: row.sequence_number,
    sender:
      row.sender_user_id === null
        ? ('system' as const)
        : row.sender_user_id === viewerUserId
          ? ('self' as const)
          : ('match' as const),
    createdAt: row.created_at.toISOString(),
  };
  switch (row.message_type) {
    case 'predefined_question':
      if (row.predefined_question_id === null || row.question_text_key === null) unavailable();
      return {
        ...base,
        messageType: 'predefined_question',
        content: { questionId: row.predefined_question_id, textKey: row.question_text_key },
      };
    case 'predefined_answer':
      if (
        row.predefined_answer_id === null ||
        row.answer_question_id === null ||
        row.answer_text_key === null
      )
        unavailable();
      return {
        ...base,
        messageType: 'predefined_answer',
        content: {
          questionId: row.answer_question_id,
          answerId: row.predefined_answer_id,
          textKey: row.answer_text_key,
        },
      };
    case 'text':
      if (row.text === null) unavailable();
      return { ...base, messageType: 'text', content: { text: row.text } };
    case 'system':
      if (row.text === null || row.system_arguments === null) unavailable();
      return {
        ...base,
        sender: 'system',
        messageType: 'system',
        content: {
          textKey: row.text,
          arguments: Object.fromEntries(
            Object.entries(row.system_arguments).map(([key, value]) => [key, String(value)]),
          ),
        },
      };
  }
}

export class PostgresChatStateStore implements ChatHistoryStore, ChatParticipantStateStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async readPage(input: {
    userId: string;
    chatSessionId: string;
    limit: number;
    beforeSequenceNumber?: string;
  }): Promise<StoredChatPage> {
    const capability = await loadChatCapability(this.database, input);
    if (!capability.canRead) unavailable();
    const rows = await this.database
      .selectFrom('chat.chat_messages as message')
      .leftJoin(
        'chat.predefined_questions as question',
        'question.id',
        'message.predefined_question_id',
      )
      .leftJoin('chat.predefined_answers as answer', 'answer.id', 'message.predefined_answer_id')
      .select([
        'message.id',
        'message.sender_user_id',
        'message.message_type',
        'message.text',
        'message.predefined_question_id',
        'message.predefined_answer_id',
        'question.text_key as question_text_key',
        'answer.question_id as answer_question_id',
        'answer.text_key as answer_text_key',
        'message.system_arguments',
        'message.sequence_number',
        'message.created_at',
      ])
      .where('message.chat_session_id', '=', input.chatSessionId)
      .orderBy('message.sequence_number', 'desc')
      .limit(CHAT_VISIBLE_MESSAGE_LIMIT)
      .execute();
    const eligible =
      input.beforeSequenceNumber === undefined
        ? rows
        : rows.filter((row) => BigInt(row.sequence_number) < BigInt(input.beforeSequenceNumber!));
    const page = eligible.slice(0, input.limit);
    return {
      items: page.map((row) => toMessage(row, input.userId)),
      hasMore: eligible.length > page.length,
    };
  }

  public markRead(write: MarkChatReadWrite): Promise<ChatReadResult> {
    if (write.command.actor.kind !== 'user') return Promise.reject(new Error('unreachable'));
    return this.database.transaction().execute(async (transaction) => {
      const occurredAt = await databaseTime(transaction);
      const replay = await claimCommand<ChatReadResult>(transaction, write, occurredAt);
      if (replay !== undefined) return replay;
      const capability = await loadChatCapability(transaction, {
        userId: write.command.actor.userId,
        chatSessionId: write.chatSessionId,
      });
      if (!capability.canRead) unavailable();
      const participant = await transaction
        .selectFrom('chat.chat_participants')
        .select(['last_read_at', 'last_read_sequence_number', 'version'])
        .where('chat_session_id', '=', write.chatSessionId)
        .where('user_id', '=', write.command.actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const target = write.command.data.throughSequenceNumber;
      const message = await transaction
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('chat_session_id', '=', write.chatSessionId)
        .where('sequence_number', '=', target)
        .executeTakeFirst();
      if (message === undefined) unavailable();
      const advances =
        participant.last_read_sequence_number === null ||
        BigInt(target) > BigInt(participant.last_read_sequence_number);
      const throughSequenceNumber = advances ? target : participant.last_read_sequence_number!;
      const readAt = advances ? occurredAt : participant.last_read_at!;
      if (advances) {
        await transaction
          .updateTable('chat.chat_participants')
          .set({
            last_read_at: occurredAt,
            last_read_sequence_number: target,
            version: participant.version + 1,
          })
          .where('chat_session_id', '=', write.chatSessionId)
          .where('user_id', '=', write.command.actor.userId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.eventId,
            aggregate_type: 'chat_participant',
            aggregate_id: write.command.actor.userId,
            event_type: 'chat.read-advanced.v1',
            schema_version: 1,
            payload: { chatSessionId: write.chatSessionId, throughSequenceNumber: target },
            occurred_at: occurredAt,
            available_at: occurredAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: write.command.requestId,
            causation_id: write.command.commandId,
          })
          .execute();
      }
      const result: ChatReadResult = {
        throughSequenceNumber,
        readAt: readAt.toISOString(),
        replayed: false,
      };
      await completeCommand(transaction, write, result, occurredAt);
      return result;
    });
  }

  public changeMute(write: ChangeChatMuteWrite): Promise<ChatMuteResult> {
    if (write.command.actor.kind !== 'user') return Promise.reject(new Error('unreachable'));
    return this.database.transaction().execute(async (transaction) => {
      const occurredAt = await databaseTime(transaction);
      const replay = await claimCommand<ChatMuteResult>(transaction, write, occurredAt);
      if (replay !== undefined) return replay;
      const capability = await loadChatCapability(transaction, {
        userId: write.command.actor.userId,
        chatSessionId: write.chatSessionId,
      });
      if (!capability.canRead) unavailable();
      const participant = await transaction
        .selectFrom('chat.chat_participants')
        .select(['muted_at', 'version'])
        .where('chat_session_id', '=', write.chatSessionId)
        .where('user_id', '=', write.command.actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (participant.version !== write.command.data.expectedVersion)
        throw new ApplicationError('conflict', 'error.chat.version_conflict', 409);
      const alreadyDesired = (participant.muted_at !== null) === write.command.data.muted;
      const version = alreadyDesired ? participant.version : participant.version + 1;
      if (!alreadyDesired) {
        await transaction
          .updateTable('chat.chat_participants')
          .set({ muted_at: write.command.data.muted ? occurredAt : null, version })
          .where('chat_session_id', '=', write.chatSessionId)
          .where('user_id', '=', write.command.actor.userId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.eventId,
            aggregate_type: 'chat_participant',
            aggregate_id: write.command.actor.userId,
            event_type: 'chat.mute-changed.v1',
            schema_version: 1,
            payload: {
              chatSessionId: write.chatSessionId,
              muted: write.command.data.muted,
              version,
            },
            occurred_at: occurredAt,
            available_at: occurredAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: write.command.requestId,
            causation_id: write.command.commandId,
          })
          .execute();
      }
      const result: ChatMuteResult = {
        muted: write.command.data.muted,
        changedAt: occurredAt.toISOString(),
        version,
        replayed: false,
      };
      await completeCommand(transaction, write, result, occurredAt);
      return result;
    });
  }
}
