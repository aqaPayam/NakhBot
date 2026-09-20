import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '@nakh/domain';

import { createDatabase, type NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { runMigrations } from './migrations.js';
import {
  PostgresTelegramLikedByDeliveryStore,
  type TelegramLikedByDeliveryErrorCode,
  type TelegramLikedByDeliveryInput,
} from './telegram-liked-by-delivery-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const userId = randomUUID();
const telegramUserId = String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000));
const botId = String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));
const updateBase = 1_000_000_000 + Math.floor(Math.random() * 8_000_000_000);
const cursor = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';

function request(index: number): TelegramLikedByDeliveryInput {
  return {
    botId,
    updateId: String(updateBase + index),
    userId,
    telegramUserId,
    requestId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M3 durable Telegram Liked By handoff', () => {
  let database: NakhDatabase;
  let store: PostgresTelegramLikedByDeliveryStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 10,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    const now = new Date();
    await database
      .insertInto('identity.users')
      .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
      .execute();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: telegramUserId,
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    store = new PostgresTelegramLikedByDeliveryStore(
      database,
      new SystemIdGenerator(),
      new SystemClock(),
    );
  });

  afterAll(async () => {
    if (database === undefined) return;
    const deliveries = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .select('id')
      .where('viewer_user_id', '=', userId)
      .execute();
    const ids = deliveries.map((item) => item.id);
    if (ids.length > 0)
      await database
        .deleteFrom('platform.outbox_events')
        .where('aggregate_type', '=', 'telegram_liked_by_delivery')
        .where('aggregate_id', 'in', ids)
        .execute();
    await database
      .deleteFrom('channel_telegram.liked_by_delivery_requests')
      .where('viewer_user_id', '=', userId)
      .execute();
    await database
      .deleteFrom('identity.telegram_identities')
      .where('user_id', '=', userId)
      .execute();
    await database.deleteFrom('identity.users').where('id', '=', userId).execute();
    await database.destroy();
  });

  it('deduplicates simultaneous transport replays into one request and one minimal outbox fact', async () => {
    const input = request(1);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.enqueue({ ...input, requestId: randomUUID() })),
    );
    expect(new Set(results.map((result) => result.deliveryId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const deliveryId = results[0]!.deliveryId;
    const row = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .selectAll()
      .where('id', '=', deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      bot_id: botId,
      update_id: input.updateId,
      viewer_user_id: userId,
      state: 'pending',
      cursor: null,
    });
    const events = await database
      .selectFrom('platform.outbox_events')
      .select(['event_type', 'payload', 'published_at'])
      .where('aggregate_id', '=', deliveryId)
      .execute();
    expect(events).toEqual([
      {
        event_type: 'telegram.liked-by-delivery-requested.v1',
        payload: { deliveryId },
        published_at: null,
      },
    ]);
    expect(JSON.stringify(row)).not.toContain('deliveryUrl');
    expect(JSON.stringify(events)).not.toContain(telegramUserId);
  });

  it('persists only an opaque cursor and rejects a changed duplicate update', async () => {
    const input = { ...request(2), cursor, callbackQueryId: 'callback-id' };
    const first = await store.enqueue(input);
    expect((await store.enqueue({ ...input, requestId: randomUUID() })).deliveryId).toBe(
      first.deliveryId,
    );
    await expect(
      store.enqueue({ ...input, cursor: 'v1.lb.ponmlkjihgfedcba.abcdefghijklmnop' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    const row = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .select(['cursor', 'callback_query_id'])
      .where('id', '=', first.deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ cursor, callback_query_id: 'callback-id' });
  });

  it('rejects forged identity bindings and malformed request pairs without an outbox event', async () => {
    await expect(store.enqueue({ ...request(3), userId: randomUUID() })).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    await expect(store.enqueue({ ...request(4), cursor })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
    expect(
      await database
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .select('id')
        .where('bot_id', '=', botId)
        .where('update_id', 'in', [String(updateBase + 3), String(updateBase + 4)])
        .execute(),
    ).toHaveLength(0);
  });

  it('claims each due request once and fences a former attempt after retry', async () => {
    const target = await store.enqueue(request(5));
    const [first, second] = await Promise.all([
      store.claimBatch({ owner: 'sender-a', leaseMs: 30_000, limit: 100 }),
      store.claimBatch({ owner: 'sender-b', leaseMs: 30_000, limit: 100 }),
    ]);
    const claimed = [
      ...first.map((item) => ({ ...item, owner: 'sender-a' })),
      ...second.map((item) => ({ ...item, owner: 'sender-b' })),
    ];
    expect(new Set(claimed.map((item) => item.id)).size).toBe(claimed.length);
    const delivery = claimed.find((item) => item.id === target.deliveryId);
    expect(delivery).toMatchObject({ id: target.deliveryId, attemptCount: 1 });
    const settlement = {
      id: target.deliveryId,
      owner: delivery!.owner,
      attemptCount: delivery!.attemptCount,
    };
    expect(await store.markDelivered({ ...settlement, owner: 'other-sender' })).toBe(false);
    expect(
      await store.releaseForRetry({
        ...settlement,
        errorCode: 'provider_timeout',
        delayMs: 60_000,
      }),
    ).toBe(true);
    expect(await store.claimBatch({ owner: 'sender-c', leaseMs: 30_000, limit: 100 })).toEqual([]);
    await database
      .updateTable('channel_telegram.liked_by_delivery_requests')
      .set({ available_at: new Date(Date.now() - 1_000) })
      .where('id', '=', target.deliveryId)
      .execute();
    const reclaimed = await store.claimBatch({
      owner: settlement.owner,
      leaseMs: 30_000,
      limit: 1,
    });
    expect(reclaimed).toMatchObject([{ id: target.deliveryId, attemptCount: 2 }]);
    expect(await store.markDelivered(settlement)).toBe(false);
    expect(await store.markDelivered({ ...settlement, attemptCount: 2 })).toBe(true);
    const stored = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .select(['state', 'delivered_at', 'lease_owner', 'last_error_code'])
      .where('id', '=', target.deliveryId)
      .executeTakeFirstOrThrow();
    expect(stored.state).toBe('delivered');
    expect(stored.delivered_at).toBeInstanceOf(Date);
    expect(stored.lease_owner).toBeNull();
    expect(stored.last_error_code).toBeNull();
  });

  it('marks terminal failures without retaining raw provider errors or reclaiming them', async () => {
    const target = await store.enqueue(request(6));
    const claimed = await store.claimBatch({ owner: 'sender-d', leaseMs: 30_000, limit: 100 });
    const delivery = claimed.find((item) => item.id === target.deliveryId)!;
    const settlement = { id: delivery.id, owner: 'sender-d', attemptCount: delivery.attemptCount };
    await expect(
      store.markFailed({
        ...settlement,
        errorCode: `provider_${telegramUserId}` as TelegramLikedByDeliveryErrorCode,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await store.markFailed({ ...settlement, errorCode: 'provider_rejected' })).toBe(true);
    expect(await store.markFailed({ ...settlement, errorCode: 'provider_rejected' })).toBe(false);
    const stored = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .select(['state', 'last_error_code', 'lease_owner'])
      .where('id', '=', target.deliveryId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      state: 'failed',
      last_error_code: 'provider_rejected',
      lease_owner: null,
    });
    expect(await store.claimBatch({ owner: 'sender-e', leaseMs: 30_000, limit: 100 })).toEqual([]);
  });

  it('reports aggregate pending count and oldest age without returning request identity', async () => {
    const before = await store.measureBacklog();
    const target = await store.enqueue(request(8));
    const pending = await store.measureBacklog();
    expect(pending.pendingCount).toBe(before.pendingCount + 1);
    expect(pending.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(Object.keys(pending).sort()).toEqual(['oldestAgeSeconds', 'pendingCount']);

    const claimed = await store.claimBatch({
      owner: 'metrics-sender',
      leaseMs: 30_000,
      limit: 100,
    });
    const delivery = claimed.find((item) => item.id === target.deliveryId)!;
    expect(
      await store.markDelivered({
        id: delivery.id,
        owner: 'metrics-sender',
        attemptCount: delivery.attemptCount,
      }),
    ).toBe(true);
    expect((await store.measureBacklog()).pendingCount).toBe(before.pendingCount);
  });

  it('records only opaque known-success receipts under the current fenced lease', async () => {
    const target = await store.enqueue(request(7));
    const claimed = await store.claimBatch({
      owner: 'receipt-sender',
      leaseMs: 30_000,
      limit: 100,
    });
    const delivery = claimed.find((item) => item.id === target.deliveryId)!;
    const settlement = {
      id: delivery.id,
      owner: 'receipt-sender',
      attemptCount: delivery.attemptCount,
    };
    const messageKey = 'card:v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
    expect(await store.loadRecordedMessageKeys(settlement)).toEqual([]);
    expect(
      await store.recordMessageReceipt({ ...settlement, messageKey, providerMessageId: 42 }),
    ).toEqual({ outcome: 'recorded', providerMessageId: 42 });
    expect(
      await store.recordMessageReceipt({ ...settlement, messageKey, providerMessageId: 99 }),
    ).toEqual({ outcome: 'replayed', providerMessageId: 42 });
    expect(await store.loadRecordedMessageKeys(settlement)).toEqual([messageKey]);
    expect(
      await store.recordMessageReceipt({
        ...settlement,
        owner: 'former-sender',
        messageKey: 'screen:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        providerMessageId: 43,
      }),
    ).toEqual({ outcome: 'lease_lost' });
    await expect(
      store.recordMessageReceipt({
        ...settlement,
        messageKey: `card:raw-user-${userId}`,
        providerMessageId: 44,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await store.markDelivered(settlement)).toBe(true);
    expect(await store.loadRecordedMessageKeys(settlement)).toBeUndefined();
    const stored = await database
      .selectFrom('channel_telegram.liked_by_delivery_receipts')
      .selectAll()
      .where('delivery_id', '=', target.deliveryId)
      .execute();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(userId);
    expect(JSON.stringify(stored)).not.toContain('deliveryUrl');
  });
});
