import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '@nakh/domain';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { SystemIdGenerator } from './foundation-store.js';
import { PostgresTelegramUserResolver } from './telegram-user-resolver.js';
import {
  PostgresTelegramLikedByDeliveryStore,
  type TelegramLikedByDeliveryInput,
} from './telegram-liked-by-delivery-store.js';
import { PostgresLikedByStore } from './liked-by-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original Liked By request life', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_liked_by_life');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  const store = (): PostgresTelegramLikedByDeliveryStore =>
    new PostgresTelegramLikedByDeliveryStore(database, new SystemIdGenerator(), new SystemClock());
  async function owner(): Promise<TelegramLikedByDeliveryInput> {
    const userId = await createReportUser(database, true),
      now = new Date();
    const telegramUserId = String(1000000000000 + Math.floor(Math.random() * 8000000000000));
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
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: userId, visibility_enabled: true, created_at: now, updated_at: now })
      .execute();
    return {
      userId,
      telegramUserId,
      productEpoch: 0,
      botId: '12345',
      updateId: String(Math.floor(Math.random() * 1000000000)),
      requestId: randomUUID(),
    };
  }
  it('captures native identity and epoch together and rejects unknown provider identities', async () => {
    const input = await owner(),
      resolver = new PostgresTelegramUserResolver(database);
    expect(await resolver.resolveProductLife(input.telegramUserId)).toEqual({
      userId: input.userId,
      productEpoch: 0,
    });
    expect(await resolver.resolveProductLife('0')).toBeUndefined();
    expect(await resolver.resolveProductLife('99999999999999999')).toBeUndefined();
  });
  it('converges twenty replays while preserving original life through lease claim', async () => {
    const input = await owner();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store().enqueue({ ...input, requestId: randomUUID() })),
    );
    expect(new Set(results.map((result) => result.deliveryId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const row = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .selectAll()
      .where('id', '=', results[0]!.deliveryId)
      .executeTakeFirstOrThrow();
    expect(row.product_epoch).toBe(0);
    const claims = await store().claimBatch({ owner: randomUUID(), leaseMs: 30000, limit: 100 });
    expect(claims.find((claim) => claim.id === row.id)?.productEpoch).toBe(0);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', row.id)
        .execute(),
    ).toHaveLength(1);
  });
  it('rejects original owner and epoch rewrites without changing the request', async () => {
    const input = await owner(),
      other = await owner(),
      result = await store().enqueue(input);
    await expect(
      database
        .updateTable('channel_telegram.liked_by_delivery_requests')
        .set({ product_epoch: 1 })
        .where('id', '=', result.deliveryId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database
        .updateTable('channel_telegram.liked_by_delivery_requests')
        .set({ viewer_user_id: other.userId })
        .where('id', '=', result.deliveryId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    const row = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .select(['viewer_user_id', 'product_epoch'])
      .where('id', '=', result.deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ viewer_user_id: input.userId, product_epoch: 0 });
  });
  it('rejects mismatched admission before either request or outbox allocation commits', async () => {
    const input = await owner();
    await expect(store().enqueue({ ...input, productEpoch: 1 })).rejects.toMatchObject({
      code: '40001',
    });
    expect(
      await database
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .select('id')
        .where('viewer_user_id', '=', input.userId)
        .execute(),
    ).toEqual([]);
    for (const productEpoch of [-1, NaN, 0.5])
      await expect(store().enqueue({ ...input, productEpoch })).rejects.toMatchObject({
        code: 'invalid_request',
      });
  });
  it('blocks a captured request and provider identity immediately after an actual tombstone', async () => {
    let captured: Awaited<ReturnType<PostgresTelegramUserResolver['resolveProductLife']>>;
    let telegramUserId = '';
    await createDeletionFixture(database, async (userId) => {
      const identity = await database
        .selectFrom('identity.telegram_identities')
        .select('telegram_user_id')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      telegramUserId = identity.telegram_user_id;
      captured = await new PostgresTelegramUserResolver(database).resolveProductLife(
        telegramUserId,
      );
    });
    expect(captured).toBeDefined();
    expect(
      await new PostgresTelegramUserResolver(database).resolveProductLife(telegramUserId),
    ).toBeUndefined();
    await expect(
      store().enqueue({
        ...captured!,
        telegramUserId,
        botId: '12345',
        updateId: '99',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: '40001' });
  });
  it('rejects delayed page work for a different native epoch without claiming a real Return', async () => {
    const input = await owner(),
      query = {
        actor: { kind: 'user' as const, userId: input.userId },
        requestId: randomUUID(),
        limit: 5,
      };
    expect(
      await new PostgresLikedByStore(database).readActionablePage(query, undefined, 0),
    ).toEqual({ totalCount: 0, rows: [], hasMore: false });
    // Privileged corruption probe only: the real approved Return saga remains disabled.
    await database.transaction().execute(async (tx) => {
      await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
      try {
        await tx
          .updateTable('identity.accounts')
          .set({ product_epoch: 1 })
          .where('user_id', '=', input.userId)
          .execute();
      } finally {
        await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
      }
    });
    await expect(
      new PostgresLikedByStore(database).readActionablePage(query, undefined, 0),
    ).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(store().enqueue(input)).rejects.toMatchObject({ code: '40001' });
    expect(
      await new PostgresTelegramUserResolver(database).resolveProductLife(input.telegramUserId),
    ).toEqual({ userId: input.userId, productEpoch: 1 });
  });
});
