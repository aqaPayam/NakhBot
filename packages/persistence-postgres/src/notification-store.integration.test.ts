import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NotificationType } from '@nakh/domain';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresNotificationStore, type NotificationWrite } from './notification-store.js';
import { PostgresNotificationDeliveryStore } from './notification-delivery-store.js';

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

async function createDeliverableUser(database: NakhDatabase): Promise<string> {
  const userId = await createMutedUser(database);
  const now = new Date();
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: String(1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)),
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({
      user_id: userId,
      visibility_enabled: true,
      ui_locale_code: 'en',
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

  it('fences delivery claims and quarantines a possibly-sent provider call', async () => {
    const userId = await createMutedUser(database);
    const recorded = await store.record(notice(userId, 'safety_notice'));
    const deliveryId = recorded.telegramDeliveryId!;
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await database
      .updateTable('notification.notification_deliveries')
      .set({
        attempt_number: 1,
        fence_token: '1',
        lease_owner: 'worker:one',
        lease_expires_at: leaseExpiresAt,
        version: 2,
      })
      .where('id', '=', deliveryId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('notification.notification_deliveries')
      .set({ provider_progress: 'call_started', version: 3 })
      .where('id', '=', deliveryId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .updateTable('notification.notification_deliveries')
        .set({
          attempt_number: 2,
          fence_token: '2',
          lease_owner: 'worker:two',
          lease_expires_at: new Date(Date.now() + 120_000),
          provider_progress: 'not_started',
          version: 4,
        })
        .where('id', '=', deliveryId)
        .execute(),
    ).rejects.toThrow(/claim/u);

    const quarantinedAt = new Date();
    await database
      .updateTable('notification.notification_deliveries')
      .set({
        status: 'failed_terminal',
        next_attempt_at: null,
        failed_at: quarantinedAt,
        failure_code: 'ambiguous_result',
        provider_progress: 'ambiguous',
        lease_owner: null,
        lease_expires_at: null,
        quarantined_at: quarantinedAt,
        updated_at: quarantinedAt,
        version: 4,
      })
      .where('id', '=', deliveryId)
      .executeTakeFirstOrThrow();
    expect(
      await database
        .selectFrom('notification.notification_deliveries')
        .select([
          'status',
          'attempt_number',
          'fence_token',
          'provider_progress',
          'failure_code',
          'lease_owner',
          'quarantined_at',
        ])
        .where('id', '=', deliveryId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: 'failed_terminal',
      attempt_number: 1,
      fence_token: '1',
      provider_progress: 'ambiguous',
      failure_code: 'ambiguous_result',
      lease_owner: null,
      quarantined_at: quarantinedAt,
    });
  });

  it('claims, authorizes, and settles one Telegram delivery under its exact fence', async () => {
    const userId = await createDeliverableUser(database);
    const recorded = await store.record(notice(userId, 'safety_notice'));
    const deliveryId = recorded.telegramDeliveryId!;
    const deliveries = new PostgresNotificationDeliveryStore(database);
    const claims = await deliveries.claimDue({
      workerId: 'notification:worker-one',
      leaseMs: 60_000,
      limit: 100,
    });
    const claim = claims.find((candidate) => candidate.deliveryId === deliveryId);
    expect(claim).toBeDefined();
    const lease = {
      deliveryId,
      leaseOwner: 'notification:worker-one',
      fenceToken: claim!.fenceToken,
    };
    await expect(deliveries.loadTelegramProjection(lease)).resolves.toMatchObject({
      deliveryId,
      locale: 'en',
      titleKey: 'notification.safety_notice.title',
      bodyKey: 'notification.safety_notice.body',
    });
    await expect(deliveries.markProviderCallStarted(lease)).resolves.toBe(true);
    await expect(
      deliveries.settle({
        ...lease,
        attemptNumber: claim!.attemptNumber,
        outcome: 'sent',
        providerMessageKey: 'telegram:42',
      }),
    ).resolves.toBe(true);
    await expect(
      deliveries.settle({
        ...lease,
        attemptNumber: claim!.attemptNumber,
        outcome: 'failed_terminal',
        failureCode: 'recipient_unavailable',
        quarantine: false,
      }),
    ).resolves.toBe(false);
    expect(
      await database
        .selectFrom('notification.notification_deliveries')
        .select([
          'status',
          'provider_progress',
          'provider_delivery_key',
          'lease_owner',
          'lease_expires_at',
        ])
        .where('id', '=', deliveryId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: 'sent',
      provider_progress: 'settled',
      provider_delivery_key: 'telegram:42',
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it('retries a known failure but quarantines an ambiguous provider call', async () => {
    const userId = await createDeliverableUser(database);
    const recorded = await store.record(notice(userId, 'safety_notice'));
    const deliveryId = recorded.telegramDeliveryId!;
    const deliveries = new PostgresNotificationDeliveryStore(database);
    const firstClaims = await deliveries.claimDue({
      workerId: 'notification:retry-one',
      leaseMs: 60_000,
      limit: 100,
    });
    const first = firstClaims.find((candidate) => candidate.deliveryId === deliveryId)!;
    const firstLease = {
      deliveryId,
      leaseOwner: 'notification:retry-one',
      fenceToken: first.fenceToken,
    };
    expect(await deliveries.markProviderCallStarted(firstLease)).toBe(true);
    expect(
      await deliveries.settle({
        ...firstLease,
        attemptNumber: first.attemptNumber,
        outcome: 'failed_retryable',
        failureCode: 'rate_limited',
        retryDelayMs: 1,
      }),
    ).toBe(true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));

    const secondClaims = await deliveries.claimDue({
      workerId: 'notification:retry-two',
      leaseMs: 60_000,
      limit: 100,
    });
    const second = secondClaims.find((candidate) => candidate.deliveryId === deliveryId)!;
    expect(second.attemptNumber).toBe(first.attemptNumber + 1);
    expect(BigInt(second.fenceToken)).toBe(BigInt(first.fenceToken) + 1n);
    const secondLease = {
      deliveryId,
      leaseOwner: 'notification:retry-two',
      fenceToken: second.fenceToken,
    };
    expect(await deliveries.markProviderCallStarted(secondLease)).toBe(true);
    expect(
      await deliveries.settle({
        ...secondLease,
        attemptNumber: second.attemptNumber,
        outcome: 'failed_terminal',
        failureCode: 'ambiguous_result',
        quarantine: true,
      }),
    ).toBe(true);
    expect(
      await deliveries.settle({
        ...firstLease,
        attemptNumber: first.attemptNumber,
        outcome: 'sent',
        providerMessageKey: 'telegram:stale',
      }),
    ).toBe(false);
    const quarantined = await database
      .selectFrom('notification.notification_deliveries')
      .select(['status', 'provider_progress', 'failure_code', 'quarantined_at'])
      .where('id', '=', deliveryId)
      .executeTakeFirstOrThrow();
    expect(quarantined).toMatchObject({
      status: 'failed_terminal',
      provider_progress: 'ambiguous',
      failure_code: 'ambiguous_result',
    });
    expect(quarantined.quarantined_at).toBeInstanceOf(Date);
  });
});
