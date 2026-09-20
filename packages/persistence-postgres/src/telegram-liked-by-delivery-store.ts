import type { Clock, IdGenerator } from '@nakh/domain';
import { ApplicationError } from '@nakh/domain';
import { sql } from 'kysely';

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

export type ClaimedTelegramLikedByDelivery = Readonly<{
  id: string;
  botId: string;
  updateId: string;
  viewerUserId: string;
  telegramUserId: string;
  requestId: string;
  cursor?: string;
  callbackQueryId?: string;
  attemptCount: number;
}>;

export type TelegramLikedByDeliveryClaim = Readonly<{
  owner: string;
  leaseMs: number;
  limit: number;
}>;

export type TelegramLikedByDeliverySettlement = Readonly<{
  id: string;
  owner: string;
  attemptCount: number;
}>;

export type TelegramLikedByDeliveryErrorCode =
  | 'identity_unavailable'
  | 'page_unavailable'
  | 'media_unavailable'
  | 'provider_timeout'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'retry_exhausted'
  | 'unknown_failure';

export type TelegramLikedByDeliveryReceiptInput = TelegramLikedByDeliverySettlement &
  Readonly<{
    messageKey: string;
    providerMessageId: number;
  }>;

export type TelegramLikedByDeliveryReceiptResult = Readonly<{
  outcome: 'recorded' | 'replayed' | 'lease_lost';
  providerMessageId?: number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_ID = /^[1-9][0-9]{0,19}$/u;
const UPDATE_ID = /^(?:0|[1-9][0-9]{0,19})$/u;
const CURSOR = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;
const OWNER = /^[\x20-\x7e]{1,128}$/u;
const MESSAGE_KEY = /^(?:card|screen):[A-Za-z0-9._-]{1,80}$/u;
const ERROR_CODES = new Set<TelegramLikedByDeliveryErrorCode>([
  'identity_unavailable',
  'page_unavailable',
  'media_unavailable',
  'provider_timeout',
  'provider_rejected',
  'provider_unavailable',
  'retry_exhausted',
  'unknown_failure',
]);

function validErrorCode(value: unknown): value is TelegramLikedByDeliveryErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value as TelegramLikedByDeliveryErrorCode);
}

function invalidLease(): never {
  throw new ApplicationError('invalid_request', 'error.interaction.unavailable', 400);
}

function validateSettlement(input: TelegramLikedByDeliverySettlement): void {
  if (
    typeof input.id !== 'string' ||
    !UUID.test(input.id) ||
    typeof input.owner !== 'string' ||
    !OWNER.test(input.owner) ||
    !Number.isSafeInteger(input.attemptCount) ||
    input.attemptCount < 1
  )
    invalidLease();
}

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

  /** Claim only due requests. The attempt number fences a former owner after lease expiry. */
  public async claimBatch(
    input: TelegramLikedByDeliveryClaim,
  ): Promise<ClaimedTelegramLikedByDelivery[]> {
    if (
      typeof input.owner !== 'string' ||
      !OWNER.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 900_000 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      invalidLease();
    return this.database.transaction().execute(async (transaction) => {
      const due = await transaction
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .select('id')
        .where('state', '=', 'pending')
        .where('available_at', '<=', sql<Date>`clock_timestamp()`)
        .where((expression) =>
          expression.or([
            expression('lease_expires_at', 'is', null),
            expression('lease_expires_at', '<', sql<Date>`clock_timestamp()`),
          ]),
        )
        .orderBy('available_at', 'asc')
        .orderBy('id', 'asc')
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (due.length === 0) return [];
      const rows = await transaction
        .updateTable('channel_telegram.liked_by_delivery_requests')
        .set((expression) => ({
          lease_owner: input.owner,
          lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
          attempt_count: expression('attempt_count', '+', 1),
          updated_at: sql<Date>`clock_timestamp()`,
        }))
        .where(
          'id',
          'in',
          due.map(({ id }) => id),
        )
        .returningAll()
        .execute();
      return rows.map((row) => ({
        id: row.id,
        botId: row.bot_id,
        updateId: row.update_id,
        viewerUserId: row.viewer_user_id,
        telegramUserId: row.telegram_user_id,
        requestId: row.request_id,
        ...(row.cursor === null ? {} : { cursor: row.cursor }),
        ...(row.callback_query_id === null ? {} : { callbackQueryId: row.callback_query_id }),
        attemptCount: row.attempt_count,
      }));
    });
  }

  public async markDelivered(input: TelegramLikedByDeliverySettlement): Promise<boolean> {
    validateSettlement(input);
    const updated = await this.database
      .updateTable('channel_telegram.liked_by_delivery_requests')
      .set({
        state: 'delivered',
        delivered_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`clock_timestamp()`,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: null,
      })
      .where('id', '=', input.id)
      .where('state', '=', 'pending')
      .where('lease_owner', '=', input.owner)
      .where('attempt_count', '=', input.attemptCount)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  public async loadRecordedMessageKeys(
    input: TelegramLikedByDeliverySettlement,
  ): Promise<readonly string[] | undefined> {
    validateSettlement(input);
    return this.database.transaction().execute(async (transaction) => {
      const lease = await transaction
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .select('id')
        .where('id', '=', input.id)
        .where('state', '=', 'pending')
        .where('lease_owner', '=', input.owner)
        .where('attempt_count', '=', input.attemptCount)
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (lease === undefined) return undefined;
      const receipts = await transaction
        .selectFrom('channel_telegram.liked_by_delivery_receipts')
        .select('message_key')
        .where('delivery_id', '=', input.id)
        .orderBy('message_key', 'asc')
        .execute();
      return receipts.map(({ message_key: messageKey }) => messageKey);
    });
  }

  public async recordMessageReceipt(
    input: TelegramLikedByDeliveryReceiptInput,
  ): Promise<TelegramLikedByDeliveryReceiptResult> {
    validateSettlement(input);
    if (
      typeof input.messageKey !== 'string' ||
      !MESSAGE_KEY.test(input.messageKey) ||
      !Number.isSafeInteger(input.providerMessageId) ||
      input.providerMessageId < 1
    )
      invalidLease();
    return this.database.transaction().execute(async (transaction) => {
      const lease = await transaction
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .select('id')
        .where('id', '=', input.id)
        .where('state', '=', 'pending')
        .where('lease_owner', '=', input.owner)
        .where('attempt_count', '=', input.attemptCount)
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (lease === undefined) return { outcome: 'lease_lost' };
      const inserted = await transaction
        .insertInto('channel_telegram.liked_by_delivery_receipts')
        .values({
          delivery_id: input.id,
          message_key: input.messageKey,
          provider_message_id: String(input.providerMessageId),
          recorded_at: sql<Date>`clock_timestamp()`,
        })
        .onConflict((conflict) => conflict.columns(['delivery_id', 'message_key']).doNothing())
        .returning('provider_message_id')
        .executeTakeFirst();
      if (inserted !== undefined)
        return { outcome: 'recorded', providerMessageId: Number(inserted.provider_message_id) };
      const existing = await transaction
        .selectFrom('channel_telegram.liked_by_delivery_receipts')
        .select('provider_message_id')
        .where('delivery_id', '=', input.id)
        .where('message_key', '=', input.messageKey)
        .executeTakeFirstOrThrow();
      return { outcome: 'replayed', providerMessageId: Number(existing.provider_message_id) };
    });
  }

  public async releaseForRetry(
    input: TelegramLikedByDeliverySettlement &
      Readonly<{ errorCode: TelegramLikedByDeliveryErrorCode; delayMs: number }>,
  ): Promise<boolean> {
    validateSettlement(input);
    if (
      !validErrorCode(input.errorCode) ||
      !Number.isSafeInteger(input.delayMs) ||
      input.delayMs < 0 ||
      input.delayMs > 3_600_000
    )
      invalidLease();
    const updated = await this.database
      .updateTable('channel_telegram.liked_by_delivery_requests')
      .set({
        lease_owner: null,
        lease_expires_at: null,
        available_at: sql<Date>`clock_timestamp() + (${input.delayMs} * interval '1 millisecond')`,
        last_error_code: input.errorCode,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', input.id)
      .where('state', '=', 'pending')
      .where('lease_owner', '=', input.owner)
      .where('attempt_count', '=', input.attemptCount)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  public async markFailed(
    input: TelegramLikedByDeliverySettlement &
      Readonly<{ errorCode: TelegramLikedByDeliveryErrorCode }>,
  ): Promise<boolean> {
    validateSettlement(input);
    if (!validErrorCode(input.errorCode)) invalidLease();
    const updated = await this.database
      .updateTable('channel_telegram.liked_by_delivery_requests')
      .set({
        state: 'failed',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: input.errorCode,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', input.id)
      .where('state', '=', 'pending')
      .where('lease_owner', '=', input.owner)
      .where('attempt_count', '=', input.attemptCount)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }
}
