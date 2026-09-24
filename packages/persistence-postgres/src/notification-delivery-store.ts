import type {
  NotificationDeliveryLease,
  NotificationDeliverySettlementWrite,
  NotificationDeliveryStore,
  TelegramNotificationProjection,
} from '@nakh/application';
import type { ClaimedNotificationDelivery } from '@nakh/contracts';
import { ApplicationError, NOTIFICATION_DELIVERY_MAX_ATTEMPTS } from '@nakh/domain';
import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNER = /^[A-Za-z0-9._:-]{1,128}$/u;
const FENCE = /^[1-9][0-9]{0,18}$/u;
const PROVIDER_KEY = /^[A-Za-z0-9._:-]{1,256}$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,79}$/u;

function invalidDelivery(): never {
  throw new ApplicationError(
    'notification_delivery_invalid',
    'error.notification.delivery_state_invalid',
    400,
  );
}

function validateLease(input: NotificationDeliveryLease): void {
  if (
    !UUID.test(input.deliveryId) ||
    !OWNER.test(input.leaseOwner) ||
    !FENCE.test(input.fenceToken)
  )
    invalidDelivery();
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Durable M6 notification delivery leases, rendering authorization, and fenced settlement. */
export class PostgresNotificationDeliveryStore implements NotificationDeliveryStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async claimDue(input: {
    workerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<ClaimedNotificationDelivery[]> {
    if (
      !OWNER.test(input.workerId) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 900_000
    )
      invalidDelivery();

    return this.database.transaction().execute(async (transaction) => {
      const due = await transaction
        .selectFrom('notification.notification_deliveries')
        .select('id')
        .where('channel', '=', 'telegram')
        .where('status', 'in', ['pending', 'failed_retryable'])
        .where('provider_progress', '=', 'not_started')
        .where('attempt_number', '<', NOTIFICATION_DELIVERY_MAX_ATTEMPTS)
        .where('next_attempt_at', '<=', sql<Date>`clock_timestamp()`)
        .where((expression) =>
          expression.or([
            expression('lease_expires_at', 'is', null),
            expression('lease_expires_at', '<=', sql<Date>`clock_timestamp()`),
          ]),
        )
        .orderBy('next_attempt_at', 'asc')
        .orderBy('id', 'asc')
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (due.length === 0) return [];

      const rows = await transaction
        .updateTable('notification.notification_deliveries')
        .set((expression) => ({
          status: 'pending',
          attempt_number: expression('attempt_number', '+', 1),
          fence_token: expression('fence_token', '+', sql<string>`1`),
          lease_owner: input.workerId,
          lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
          failed_at: null,
          failure_code: null,
          updated_at: sql<Date>`clock_timestamp()`,
          version: expression('version', '+', 1),
        }))
        .where(
          'id',
          'in',
          due.map(({ id }) => id),
        )
        .returning(['id', 'notification_id', 'fence_token', 'lease_expires_at', 'attempt_number'])
        .execute();
      return rows.map((row) => {
        if (row.lease_expires_at === null) invalidDelivery();
        return {
          deliveryId: row.id,
          notificationId: row.notification_id,
          fenceToken: row.fence_token,
          leaseExpiresAt: row.lease_expires_at.toISOString(),
          attemptNumber: row.attempt_number,
        };
      });
    });
  }

  public async loadTelegramProjection(
    lease: NotificationDeliveryLease,
  ): Promise<TelegramNotificationProjection | undefined> {
    validateLease(lease);
    const row = await this.database
      .selectFrom('notification.notification_deliveries as delivery')
      .innerJoin(
        'notification.notifications as notification',
        'notification.id',
        'delivery.notification_id',
      )
      .innerJoin(
        'identity.telegram_identities as telegram',
        'telegram.user_id',
        'notification.user_id',
      )
      .innerJoin('identity.user_settings as settings', 'settings.user_id', 'notification.user_id')
      .select([
        'delivery.id as delivery_id',
        'notification.user_id',
        'notification.notification_type',
        'notification.title_key',
        'notification.body_key',
        'notification.payload',
        'telegram.telegram_user_id',
        'settings.ui_locale_code',
      ])
      .where('delivery.id', '=', lease.deliveryId)
      .where('delivery.channel', '=', 'telegram')
      .where('delivery.status', 'in', ['pending', 'failed_retryable'])
      .where('delivery.provider_progress', '=', 'not_started')
      .where('delivery.lease_owner', '=', lease.leaseOwner)
      .where('delivery.fence_token', '=', lease.fenceToken)
      .where('delivery.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (row === undefined) return undefined;

    if (row.notification_type === 'new_chat_message') {
      const payload = object(row.payload);
      const chatSessionId = payload?.chatSessionId;
      const messageId = payload?.messageId;
      if (
        typeof chatSessionId !== 'string' ||
        !UUID.test(chatSessionId) ||
        typeof messageId !== 'string' ||
        !UUID.test(messageId)
      )
        return undefined;
      const message = await this.database
        .selectFrom('chat.chat_messages as message')
        .innerJoin('chat.chat_participants as participant', (join) =>
          join
            .onRef('participant.chat_session_id', '=', 'message.chat_session_id')
            .on('participant.user_id', '=', row.user_id),
        )
        .select('message.id')
        .where('message.id', '=', messageId)
        .where('message.chat_session_id', '=', chatSessionId)
        .executeTakeFirst();
      if (message === undefined) return undefined;
    }

    return {
      deliveryId: row.delivery_id,
      telegramUserId: row.telegram_user_id,
      locale: row.ui_locale_code,
      titleKey: row.title_key,
      bodyKey: row.body_key,
    };
  }

  public async markProviderCallStarted(lease: NotificationDeliveryLease): Promise<boolean> {
    validateLease(lease);
    const updated = await this.database
      .updateTable('notification.notification_deliveries')
      .set((expression) => ({
        provider_progress: 'call_started',
        updated_at: sql<Date>`clock_timestamp()`,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', lease.deliveryId)
      .where('channel', '=', 'telegram')
      .where('status', 'in', ['pending', 'failed_retryable'])
      .where('provider_progress', '=', 'not_started')
      .where('lease_owner', '=', lease.leaseOwner)
      .where('fence_token', '=', lease.fenceToken)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  public async settle(write: NotificationDeliverySettlementWrite): Promise<boolean> {
    validateLease(write);
    if (
      !Number.isSafeInteger(write.attemptNumber) ||
      write.attemptNumber < 1 ||
      write.attemptNumber > NOTIFICATION_DELIVERY_MAX_ATTEMPTS
    )
      invalidDelivery();
    if (write.outcome === 'sent' && !PROVIDER_KEY.test(write.providerMessageKey)) invalidDelivery();
    if (
      write.outcome !== 'sent' &&
      (!FAILURE_CODE.test(write.failureCode) ||
        (write.outcome === 'failed_retryable' &&
          (!Number.isSafeInteger(write.retryDelayMs) ||
            write.retryDelayMs < 1 ||
            write.retryDelayMs > 900_000)))
    )
      invalidDelivery();

    const base = this.database
      .updateTable('notification.notification_deliveries')
      .where('id', '=', write.deliveryId)
      .where('channel', '=', 'telegram')
      .where('status', 'in', ['pending', 'failed_retryable'])
      .where('lease_owner', '=', write.leaseOwner)
      .where('fence_token', '=', write.fenceToken)
      .where('attempt_number', '=', write.attemptNumber)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`);

    if (write.outcome === 'sent') {
      const updated = await base
        .set((expression) => ({
          status: 'sent',
          provider_progress: 'settled',
          next_attempt_at: null,
          sent_at: sql<Date>`clock_timestamp()`,
          failed_at: null,
          failure_code: null,
          provider_delivery_key: write.providerMessageKey,
          lease_owner: null,
          lease_expires_at: null,
          quarantined_at: null,
          updated_at: sql<Date>`clock_timestamp()`,
          version: expression('version', '+', 1),
        }))
        .where('provider_progress', '=', 'call_started')
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n;
    }

    if (write.outcome === 'failed_retryable') {
      const updated = await base
        .set((expression) => ({
          status: 'failed_retryable',
          provider_progress: 'not_started',
          next_attempt_at: sql<Date>`clock_timestamp() + (${write.retryDelayMs} * interval '1 millisecond')`,
          sent_at: null,
          failed_at: sql<Date>`clock_timestamp()`,
          failure_code: write.failureCode,
          provider_delivery_key: null,
          lease_owner: null,
          lease_expires_at: null,
          quarantined_at: null,
          updated_at: sql<Date>`clock_timestamp()`,
          version: expression('version', '+', 1),
        }))
        .where('provider_progress', 'in', ['not_started', 'call_started'])
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n;
    }

    const updated = await base
      .set((expression) => ({
        status: 'failed_terminal',
        provider_progress: write.quarantine ? 'ambiguous' : 'settled',
        next_attempt_at: null,
        sent_at: null,
        failed_at: sql<Date>`clock_timestamp()`,
        failure_code: write.failureCode,
        provider_delivery_key: null,
        lease_owner: null,
        lease_expires_at: null,
        quarantined_at: write.quarantine ? sql<Date>`clock_timestamp()` : null,
        updated_at: sql<Date>`clock_timestamp()`,
        version: expression('version', '+', 1),
      }))
      .where(
        'provider_progress',
        'in',
        write.quarantine ? ['call_started'] : ['not_started', 'call_started'],
      )
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }
}
