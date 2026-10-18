import type { TelegramNotificationProjection, UserSessionActor } from '@nakh/application';
import { ApplicationError, CHAT_VISIBLE_MESSAGE_LIMIT } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { loadChatCapability } from './chat-store.js';
import { projectStoredChatMessage } from './chat-message-projection.js';
import { PostgresUserSessionStore } from './user-session-store.js';

/** Called only after the delivery store's existing native scope/lease admission.
 * Read one stored visible message, never a provider body or forwarded metadata. */
export async function loadChatNotificationProjection(
  database: NakhDatabase,
  notice: Readonly<{ userId: string; productEpoch: number; payload: unknown }>,
  captureReply: boolean,
): Promise<NonNullable<TelegramNotificationProjection['chat']> | undefined> {
  const payload =
    typeof notice.payload === 'object' && notice.payload !== null && !Array.isArray(notice.payload)
      ? (notice.payload as Record<string, unknown>)
      : undefined;
  const chatSessionId = payload?.chatSessionId,
    messageId = payload?.messageId;
  if (typeof chatSessionId !== 'string' || typeof messageId !== 'string') return undefined;
  let capability;
  try {
    capability = await loadChatCapability(database, { userId: notice.userId, chatSessionId });
  } catch (error) {
    if (error instanceof ApplicationError && error.code === 'chat_unavailable') return undefined;
    throw error;
  }
  if (!capability.canRead || capability.muted) return undefined;
  const visible = database
    .selectFrom('chat.chat_messages as visible')
    .select('visible.id')
    .where('visible.chat_session_id', '=', chatSessionId)
    .orderBy('visible.sequence_number', 'desc')
    .limit(CHAT_VISIBLE_MESSAGE_LIMIT);
  const row = await database
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
    .where('message.id', '=', messageId)
    .where('message.chat_session_id', '=', chatSessionId)
    .where('message.id', 'in', visible)
    .executeTakeFirst();
  if (row === undefined || row.sender_user_id === null || row.sender_user_id === notice.userId)
    return undefined;
  const original = captureReply
    ? await new PostgresUserSessionStore(database).captureForDelivery({
        userId: notice.userId,
        productEpoch: notice.productEpoch,
      })
    : undefined;
  const replyActor: UserSessionActor | undefined =
    original === undefined
      ? undefined
      : Object.freeze({
          kind: 'user',
          userId: original.userId,
          productEpoch: original.productEpoch,
          sessionGrantId: original.id,
        });
  return Object.freeze({
    userId: notice.userId,
    productEpoch: notice.productEpoch,
    chatSessionId,
    matchId: capability.matchId,
    version: capability.version,
    canReplyWithText: capability.canSendText,
    mustShowSafetyWarning: capability.mustShowSafetyWarning,
    message: projectStoredChatMessage(row, notice.userId),
    ...(replyActor === undefined ? {} : { replyActor }),
  });
}
