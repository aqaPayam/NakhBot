import { randomUUID } from 'node:crypto';

import {
  ApplicationError,
  notificationCategory,
  shouldCreateTelegramDelivery,
  type NotificationType,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';

export type NotificationWrite = Readonly<{
  userId: string;
  type: NotificationType;
  titleKey: string;
  bodyKey: string;
  payload: Readonly<Record<string, unknown>>;
  payloadSchemaVersion?: number;
  deduplicationKey: string;
  correlationId: string;
  causationId: string;
}>;

export type StoredNotification = Readonly<{
  notificationId: string;
  telegramDeliveryId?: string;
  replayed: boolean;
}>;

function samePayload(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Records history and, when policy permits, a Telegram delivery plus transactional outbox fact. */
export async function insertNotification(
  database: NakhDatabase,
  write: NotificationWrite,
): Promise<StoredNotification> {
  const category = notificationCategory(write.type);
  const payloadSchemaVersion = write.payloadSchemaVersion ?? 1;
  const notificationId = randomUUID();
  const inserted = await database
    .insertInto('notification.notifications')
    .values({
      id: notificationId,
      user_id: write.userId,
      notification_type: write.type,
      category,
      title_key: write.titleKey,
      body_key: write.bodyKey,
      payload: write.payload,
      payload_schema_version: payloadSchemaVersion,
      deduplication_key: write.deduplicationKey,
      read_at: null,
    })
    .onConflict((conflict) => conflict.column('deduplication_key').doNothing())
    .returning(['id', 'created_at'])
    .executeTakeFirst();

  if (inserted === undefined) {
    const prior = await database
      .selectFrom('notification.notifications')
      .select([
        'id',
        'user_id',
        'notification_type',
        'title_key',
        'body_key',
        'payload',
        'payload_schema_version',
      ])
      .where('deduplication_key', '=', write.deduplicationKey)
      .executeTakeFirstOrThrow();
    if (
      prior.user_id !== write.userId ||
      prior.notification_type !== write.type ||
      prior.title_key !== write.titleKey ||
      prior.body_key !== write.bodyKey ||
      prior.payload_schema_version !== payloadSchemaVersion ||
      !samePayload(prior.payload, write.payload)
    )
      throw new ApplicationError(
        'idempotency_conflict',
        'error.notification.idempotency_conflict',
        409,
      );
    const delivery = await database
      .selectFrom('notification.notification_deliveries')
      .select('id')
      .where('notification_id', '=', prior.id)
      .where('channel', '=', 'telegram')
      .executeTakeFirst();
    return {
      notificationId: prior.id,
      ...(delivery === undefined ? {} : { telegramDeliveryId: delivery.id }),
      replayed: true,
    };
  }

  const preferences = await database
    .selectFrom('notification.notification_preferences')
    .select(['chat_enabled', 'like_enabled', 'nakh_enabled', 'match_enabled'])
    .where('user_id', '=', write.userId)
    .executeTakeFirst();
  if (preferences === undefined)
    throw new ApplicationError('not_found', 'error.notification.preferences_not_found', 404);
  if (
    !shouldCreateTelegramDelivery(write.type, {
      chatEnabled: preferences.chat_enabled,
      likeEnabled: preferences.like_enabled,
      nakhEnabled: preferences.nakh_enabled,
      matchEnabled: preferences.match_enabled,
    })
  )
    return { notificationId: inserted.id, replayed: false };

  const deliveryId = randomUUID();
  await database
    .insertInto('notification.notification_deliveries')
    .values({
      id: deliveryId,
      notification_id: inserted.id,
      channel: 'telegram',
      sent_at: null,
      failed_at: null,
      failure_code: null,
      provider_delivery_key: null,
    })
    .execute();
  await database
    .insertInto('platform.outbox_events')
    .values({
      id: randomUUID(),
      aggregate_type: 'notification_delivery',
      aggregate_id: deliveryId,
      event_type: 'notification.delivery-requested.v1',
      schema_version: 1,
      payload: { notificationId: inserted.id, deliveryId, channel: 'telegram' },
      occurred_at: inserted.created_at,
      available_at: inserted.created_at,
      published_at: null,
      last_error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      correlation_id: write.correlationId,
      causation_id: write.causationId,
    })
    .execute();
  return { notificationId: inserted.id, telegramDeliveryId: deliveryId, replayed: false };
}

export class PostgresNotificationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public record(write: NotificationWrite): Promise<StoredNotification> {
    return this.database
      .transaction()
      .execute((transaction) => insertNotification(transaction, write));
  }
}
