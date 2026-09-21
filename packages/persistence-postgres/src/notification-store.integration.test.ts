import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NotificationType } from '@nakh/domain';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresNotificationStore, type NotificationWrite } from './notification-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

async function createMutedUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('notification.notification_preferences')
    .values({
      user_id: userId,
      chat_enabled: false,
      like_enabled: false,
      nakh_enabled: false,
      match_enabled: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return userId;
}

function notice(userId: string, type: NotificationType, cause = randomUUID()): NotificationWrite {
  return {
    userId,
    type,
    titleKey: `notification.${type}.title`,
    bodyKey: `notification.${type}.body`,
    payload: { cause },
    deduplicationKey: `notification:${type}:${cause}:${userId}`,
    correlationId: cause,
    causationId: cause,
  };
}

describe.skipIf(databaseUrl === undefined)('M4 durable notification classification', () => {
  let database: NakhDatabase;
  let store: PostgresNotificationStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 12,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    store = new PostgresNotificationStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('ACC-038 retains muted history while critical notices always request Telegram delivery', async () => {
    const userId = await createMutedUser(database);
    const mutable: readonly NotificationType[] = [
      'new_chat_message',
      'like_received',
      'liked_by_profile_unlocked',
      'nakh_received',
      'pending_nakh_payment_reminder',
      'match_created',
      'chat_unlocked',
      'chat_closed',
    ];
    const critical: readonly NotificationType[] = [
      'safety_notice',
      'payment_success',
      'payment_failure',
      'report_result',
      'admin_notice',
      'ban_warning',
      'restriction_warning',
    ];

    const mutedResults = await Promise.all(
      mutable.map((type) => store.record(notice(userId, type))),
    );
    const criticalResults = await Promise.all(
      critical.map((type) => store.record(notice(userId, type))),
    );
    expect(mutedResults.every(({ telegramDeliveryId }) => telegramDeliveryId === undefined)).toBe(
      true,
    );
    expect(
      criticalResults.every(({ telegramDeliveryId }) => telegramDeliveryId !== undefined),
    ).toBe(true);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: String(mutable.length + critical.length) });
    expect(
      await database
        .selectFrom('notification.notification_deliveries as delivery')
        .innerJoin(
          'notification.notifications as notification',
          'notification.id',
          'delivery.notification_id',
        )
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('notification.user_id', '=', userId)
        .where('delivery.channel', '=', 'telegram')
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: String(critical.length) });
  });

  it('deduplicates concurrent critical delivery requests with one outbox fact', async () => {
    const userId = await createMutedUser(database);
    const input = notice(userId, 'payment_success');
    const results = await Promise.all(Array.from({ length: 20 }, () => store.record(input)));
    expect(new Set(results.map(({ notificationId }) => notificationId)).size).toBe(1);
    expect(new Set(results.map(({ telegramDeliveryId }) => telegramDeliveryId)).size).toBe(1);
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    const deliveryId = results[0]!.telegramDeliveryId!;
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('aggregate_type', '=', 'notification_delivery')
        .where('aggregate_id', '=', deliveryId)
        .where('event_type', '=', 'notification.delivery-requested.v1')
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
  });
});
