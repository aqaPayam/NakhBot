import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  PredefinedChatMessageStore,
  SendPredefinedChatMessageCommand,
  SendPredefinedChatMessageWrite,
  SendTextChatMessageWrite,
  TextChatMessageStore,
} from '@nakh/application';
import type { ChatMessageResult, SendTextMessageCommand } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { insertNotification } from './notification-store.js';
import { lockUserPair } from './pair-lock.js';

function unavailable(): never {
  throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
}

type ChatMessageWrite = SendPredefinedChatMessageWrite | SendTextChatMessageWrite;
type ChatMessageCommand = SendPredefinedChatMessageCommand | SendTextMessageCommand;

function requestHash(write: ChatMessageWrite): string {
  const command = write.command;
  const messageData =
    'normalizedText' in write
      ? {
          normalizedTextDigest: createHash('sha256').update(write.normalizedText).digest('hex'),
        }
      : {
          questionId: write.command.data.questionId,
          ...(write.command.commandType === 'chat.send-predefined-answer'
            ? { answerId: write.command.data.answerId }
            : {}),
        };
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: command.schemaVersion,
        actor: command.actor,
        chatSessionId: write.chatSessionId,
        ...messageData,
      }),
    )
    .digest('hex');
}

async function claimCommand(
  database: NakhDatabase,
  write: ChatMessageWrite,
  occurredAt: Date,
): Promise<ChatMessageResult | undefined> {
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
  return { ...(existing.response_json as unknown as ChatMessageResult), replayed: true };
}

async function completeCommand(
  database: NakhDatabase,
  command: ChatMessageCommand,
  result: ChatMessageResult,
  occurredAt: Date,
): Promise<void> {
  await database
    .updateTable('platform.idempotency_records')
    .set({ status: 'completed', response_json: result, updated_at: occurredAt })
    .where('id', '=', command.commandId)
    .executeTakeFirstOrThrow();
}

async function databaseTime(database: NakhDatabase): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  return result.rows[0]!.now;
}

type LockedChat = Readonly<{
  matchId: string;
  recipientUserId: string;
  recipientMuted: boolean;
  actorSafetyWarningShown: boolean;
  nextSequenceNumber: string;
  sessionVersion: number;
}>;

async function lockAuthorizedChat(
  database: NakhDatabase,
  chatSessionId: string,
  actorUserId: string,
): Promise<LockedChat> {
  const identity = await database
    .selectFrom('chat.chat_sessions as session')
    .innerJoin('matching.matches as match', 'match.id', 'session.match_id')
    .select(['match.id as matchId', 'match.user_low_id', 'match.user_high_id'])
    .where('session.id', '=', chatSessionId)
    .executeTakeFirst();
  if (
    identity === undefined ||
    (identity.user_low_id !== actorUserId && identity.user_high_id !== actorUserId)
  )
    unavailable();

  const accounts = await database
    .selectFrom('identity.accounts')
    .select(['user_id', 'state'])
    .where('user_id', 'in', [identity.user_low_id, identity.user_high_id])
    .orderBy('user_id')
    .forUpdate()
    .execute();
  const actor = accounts.find((account) => account.user_id === actorUserId);
  const recipient = accounts.find((account) => account.user_id !== actorUserId);
  if (
    accounts.length !== 2 ||
    actor?.state !== 'active' ||
    (recipient?.state !== 'active' && recipient?.state !== 'restricted')
  )
    unavailable();

  await lockUserPair(database, identity.user_low_id, identity.user_high_id);
  const match = await database
    .selectFrom('matching.matches as match')
    .innerJoin('interaction.user_pair_states as pair', (join) =>
      join
        .onRef('pair.user_low_id', '=', 'match.user_low_id')
        .onRef('pair.user_high_id', '=', 'match.user_high_id'),
    )
    .select(['match.status', 'pair.state'])
    .where('match.id', '=', identity.matchId)
    .forUpdate()
    .executeTakeFirst();
  if (match?.status !== 'active' || match.state !== 'matched') unavailable();

  const session = await database
    .selectFrom('chat.chat_sessions')
    .select(['status', 'next_sequence_number', 'version'])
    .where('id', '=', chatSessionId)
    .where('match_id', '=', identity.matchId)
    .forUpdate()
    .executeTakeFirst();
  if (session?.status !== 'active') unavailable();
  const participants = await database
    .selectFrom('chat.chat_participants')
    .select(['user_id', 'muted_at', 'unlock_safety_warning_shown_at'])
    .where('chat_session_id', '=', chatSessionId)
    .orderBy('user_id')
    .forUpdate()
    .execute();
  if (participants.length !== 2 || !participants.some(({ user_id }) => user_id === actorUserId))
    unavailable();
  const actorParticipant = participants.find(({ user_id }) => user_id === actorUserId);
  const recipientParticipant = participants.find(({ user_id }) => user_id !== actorUserId);
  if (recipientParticipant === undefined || recipientParticipant.user_id !== recipient.user_id)
    unavailable();
  return {
    matchId: identity.matchId,
    recipientUserId: recipientParticipant.user_id,
    recipientMuted: recipientParticipant.muted_at !== null,
    actorSafetyWarningShown: actorParticipant!.unlock_safety_warning_shown_at !== null,
    nextSequenceNumber: session.next_sequence_number,
    sessionVersion: session.version,
  };
}

type Prompt = Readonly<{
  questionId: string;
  answerId?: string;
  textKey: string;
}>;

async function loadPrompt(
  database: NakhDatabase,
  command: SendPredefinedChatMessageCommand,
): Promise<Prompt> {
  if (command.commandType === 'chat.send-predefined-question') {
    const question = await database
      .selectFrom('chat.predefined_questions as question')
      .innerJoin(
        'chat.predefined_question_sets as question_set',
        'question_set.id',
        'question.question_set_id',
      )
      .select(['question.id', 'question.text_key'])
      .where('question.id', '=', command.data.questionId)
      .where('question.is_active', '=', true)
      .where('question_set.is_active', '=', true)
      .executeTakeFirst();
    if (question === undefined) unavailable();
    return { questionId: question.id, textKey: question.text_key };
  }
  const answer = await database
    .selectFrom('chat.predefined_answers as answer')
    .innerJoin('chat.predefined_questions as question', 'question.id', 'answer.question_id')
    .innerJoin(
      'chat.predefined_question_sets as question_set',
      'question_set.id',
      'question.question_set_id',
    )
    .select(['question.id as question_id', 'answer.id', 'answer.text_key'])
    .where('question.id', '=', command.data.questionId)
    .where('answer.id', '=', command.data.answerId)
    .where('answer.is_active', '=', true)
    .where('question.is_active', '=', true)
    .where('question_set.is_active', '=', true)
    .executeTakeFirst();
  if (answer === undefined) unavailable();
  return { questionId: answer.question_id, answerId: answer.id, textKey: answer.text_key };
}

export class PostgresChatStore implements PredefinedChatMessageStore, TextChatMessageStore {
  public constructor(private readonly database: NakhDatabase) {}

  public sendPredefined(write: SendPredefinedChatMessageWrite): Promise<ChatMessageResult> {
    if (write.command.actor.kind !== 'user')
      return Promise.reject(
        new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
      );
    return this.database.transaction().execute(async (transaction) => {
      const occurredAt = await databaseTime(transaction);
      const replay = await claimCommand(transaction, write, occurredAt);
      if (replay !== undefined) return replay;
      const locked = await lockAuthorizedChat(
        transaction,
        write.chatSessionId,
        write.command.actor.userId,
      );
      const prompt = await loadPrompt(transaction, write.command);
      const sequenceNumber = locked.nextSequenceNumber;
      await transaction
        .updateTable('chat.chat_sessions')
        .set({
          next_sequence_number: String(BigInt(sequenceNumber) + 1n),
          version: locked.sessionVersion + 1,
        })
        .where('id', '=', write.chatSessionId)
        .executeTakeFirstOrThrow();
      const isQuestion = write.command.commandType === 'chat.send-predefined-question';
      await transaction
        .insertInto('chat.chat_messages')
        .values({
          id: write.messageId,
          chat_session_id: write.chatSessionId,
          sender_user_id: write.command.actor.userId,
          message_type: isQuestion ? 'predefined_question' : 'predefined_answer',
          text: null,
          predefined_question_id: isQuestion ? prompt.questionId : null,
          predefined_answer_id: isQuestion ? null : prompt.answerId!,
          system_arguments: null,
          sequence_number: sequenceNumber,
          created_at: occurredAt,
        })
        .execute();
      const result: ChatMessageResult = {
        message: isQuestion
          ? {
              messageId: write.messageId,
              sequenceNumber,
              sender: 'self',
              messageType: 'predefined_question',
              content: { questionId: prompt.questionId, textKey: prompt.textKey },
              createdAt: occurredAt.toISOString(),
            }
          : {
              messageId: write.messageId,
              sequenceNumber,
              sender: 'self',
              messageType: 'predefined_answer',
              content: {
                questionId: prompt.questionId,
                answerId: prompt.answerId!,
                textKey: prompt.textKey,
              },
              createdAt: occurredAt.toISOString(),
            },
        replayed: false,
      };
      await insertNotification(transaction, {
        userId: locked.recipientUserId,
        type: 'new_chat_message',
        titleKey: 'notification.new_chat_message.title',
        bodyKey: 'notification.new_chat_message.body',
        payload: { chatSessionId: write.chatSessionId, messageId: write.messageId },
        deduplicationKey: `chat-message:${write.messageId}:${locked.recipientUserId}`,
        correlationId: write.command.requestId,
        causationId: write.command.commandId,
        telegramDeliveryAllowed: !locked.recipientMuted,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'chat_message',
          aggregate_id: write.messageId,
          event_type: 'chat.message-created.v1',
          schema_version: 1,
          payload: {
            chatSessionId: write.chatSessionId,
            messageId: write.messageId,
            messageType: result.message.messageType,
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
      await completeCommand(transaction, write.command, result, occurredAt);
      return result;
    });
  }

  public sendText(write: SendTextChatMessageWrite): Promise<ChatMessageResult> {
    if (write.command.actor.kind !== 'user')
      return Promise.reject(
        new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
      );
    return this.database.transaction().execute(async (transaction) => {
      const occurredAt = await databaseTime(transaction);
      const replay = await claimCommand(transaction, write, occurredAt);
      if (replay !== undefined) return replay;
      const locked = await lockAuthorizedChat(
        transaction,
        write.chatSessionId,
        write.command.actor.userId,
      );
      const unlock = await transaction
        .selectFrom('interaction.feature_unlocks')
        .select('id')
        .where('feature_type', '=', 'chat_unlock')
        .where('match_id', '=', locked.matchId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (unlock === undefined || !locked.actorSafetyWarningShown)
        throw new ApplicationError('chat_unavailable', 'error.chat.text_unavailable', 409);

      const sequenceNumber = locked.nextSequenceNumber;
      await transaction
        .updateTable('chat.chat_sessions')
        .set({
          next_sequence_number: String(BigInt(sequenceNumber) + 1n),
          version: locked.sessionVersion + 1,
        })
        .where('id', '=', write.chatSessionId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('chat.chat_messages')
        .values({
          id: write.messageId,
          chat_session_id: write.chatSessionId,
          sender_user_id: write.command.actor.userId,
          message_type: 'text',
          text: write.normalizedText,
          predefined_question_id: null,
          predefined_answer_id: null,
          system_arguments: null,
          sequence_number: sequenceNumber,
          created_at: occurredAt,
        })
        .execute();
      const result: ChatMessageResult = {
        message: {
          messageId: write.messageId,
          sequenceNumber,
          sender: 'self',
          messageType: 'text',
          content: { text: write.normalizedText },
          createdAt: occurredAt.toISOString(),
        },
        replayed: false,
      };
      await insertNotification(transaction, {
        userId: locked.recipientUserId,
        type: 'new_chat_message',
        titleKey: 'notification.new_chat_message.title',
        bodyKey: 'notification.new_chat_message.body',
        payload: { chatSessionId: write.chatSessionId, messageId: write.messageId },
        deduplicationKey: `chat-message:${write.messageId}:${locked.recipientUserId}`,
        correlationId: write.command.requestId,
        causationId: write.command.commandId,
        telegramDeliveryAllowed: !locked.recipientMuted,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'chat_message',
          aggregate_id: write.messageId,
          event_type: 'chat.message-created.v1',
          schema_version: 1,
          payload: {
            chatSessionId: write.chatSessionId,
            messageId: write.messageId,
            messageType: 'text',
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
      await completeCommand(transaction, write.command, result, occurredAt);
      return result;
    });
  }
}
