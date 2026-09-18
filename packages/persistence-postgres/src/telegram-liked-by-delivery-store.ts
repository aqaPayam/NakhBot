import type { Clock, IdGenerator } from '@nakh/domain';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

export type TelegramLikedByDeliveryInput = Readonly<{
  botId: string;
  updateId: string;
  userId: string;
  telegramUserId: string;
  requestId: string;
  cursor?: string;
  callbackQueryId?: string;
}>;

export type TelegramLikedByEnqueueResult = Readonly<{
  deliveryId: string;
  replayed: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_ID = /^[1-9][0-9]{0,19}$/u;
const UPDATE_ID = /^(?:0|[1-9][0-9]{0,19})$/u;
const CURSOR = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;

function validate(input: TelegramLikedByDeliveryInput): void {
  if (
    typeof input.botId !== 'string' ||
    !PROVIDER_ID.test(input.botId) ||
    !Number.isSafeInteger(Number(input.botId)) ||
    typeof input.updateId !== 'string' ||
    !UPDATE_ID.test(input.updateId) ||
    !Number.isSafeInteger(Number(input.updateId)) ||
    typeof input.userId !== 'string' ||
    !UUID.test(input.userId) ||
    typeof input.telegramUserId !== 'string' ||
    !PROVIDER_ID.test(input.telegramUserId) ||
    !Number.isSafeInteger(Number(input.telegramUserId)) ||
    typeof input.requestId !== 'string' ||
    !UUID.test(input.requestId) ||
    (input.cursor === undefined) !== (input.callbackQueryId === undefined) ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !CURSOR.test(input.cursor))) ||
    (input.callbackQueryId !== undefined &&
      (typeof input.callbackQueryId !== 'string' ||
        input.callbackQueryId.length < 1 ||
        input.callbackQueryId.length > 128))
  )
    throw new ApplicationError('invalid_request', 'error.interaction.unavailable', 400);
}

/** Transactional, replay-safe handoff from authenticated Telegram ingress to an offline sender. */
export class PostgresTelegramLikedByDeliveryStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async enqueue(input: TelegramLikedByDeliveryInput): Promise<TelegramLikedByEnqueueResult> {
    validate(input);
    const deliveryId = this.ids.uuid();
    const eventId = this.ids.uuid();
    const now = this.clock.now();
    return this.database.transaction().execute(async (transaction) => {
      const identity = await transaction
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('user_id', '=', input.userId)
        .where('telegram_user_id', '=', input.telegramUserId)
        .executeTakeFirst();
      if (identity === undefined)
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      const inserted = await transaction
        .insertInto('channel_telegram.liked_by_delivery_requests')
        .values({
          id: deliveryId,
          bot_id: input.botId,
          update_id: input.updateId,
          viewer_user_id: input.userId,
          telegram_user_id: input.telegramUserId,
          request_id: input.requestId,
          cursor: input.cursor ?? null,
          callback_query_id: input.callbackQueryId ?? null,
          available_at: now,
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: null,
          delivered_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.columns(['bot_id', 'update_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('channel_telegram.liked_by_delivery_requests')
          .select(['id', 'viewer_user_id', 'telegram_user_id', 'cursor', 'callback_query_id'])
          .where('bot_id', '=', input.botId)
          .where('update_id', '=', input.updateId)
          .executeTakeFirstOrThrow();
        if (
          existing.viewer_user_id !== input.userId ||
          existing.telegram_user_id !== input.telegramUserId ||
          existing.cursor !== (input.cursor ?? null) ||
          existing.callback_query_id !== (input.callbackQueryId ?? null)
        )
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        return { deliveryId: existing.id, replayed: true };
      }
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: eventId,
          aggregate_type: 'telegram_liked_by_delivery',
          aggregate_id: deliveryId,
          event_type: 'telegram.liked-by-delivery-requested.v1',
          schema_version: 1,
          payload: { deliveryId },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: input.requestId,
          causation_id: input.requestId,
        })
        .execute();
      return { deliveryId, replayed: false };
    });
  }
}
