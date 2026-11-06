import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { SystemClock } from '@nakh/domain';
import {
  createDatabase,
  runMigrations,
  PostgresUserSessionStore,
  PostgresCreditLedgerStore,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramLikedByDeliveryStore,
  SystemIdGenerator,
  createPostgresUserReportServices,
  type NakhDatabase,
  type ClaimedTelegramLikedByDelivery,
} from '@nakh/persistence-postgres';
import { createRedisConnection, RedisOwnedOpaqueTokenStore } from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  TelegramLikedBySendFailure,
  type TelegramCandidateMediaRelay,
  type TelegramLockedLikedByScreenRelay,
} from '@nakh/telegram';
import {
  ReportTokens,
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  type UserSessionActor,
} from '@nakh/application';
import { createMediaAuthorityFixture } from '../../../packages/persistence-postgres/src/testing/media-authority-fixture.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramLikedByCustomerRuntime } from '../../telegram-gateway/src/liked-by-customer-runtime.js';
import { createLikedByCustomerDelivery } from './liked-by-customer-delivery.js';
import { WorkerTelegramLikedByRendererProvider } from './liked-by-renderer-provider.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
type SubmitReport = () => ReturnType<
  ReturnType<typeof createPostgresUserReportServices>['submit']['execute']
>;
type Fixture = {
  source: Awaited<ReturnType<typeof createMediaAuthorityFixture>>;
  actor: UserSessionActor;
  callback: (data: string) => ReturnType<TelegramLikedByCustomerRuntime['handle']>;
  store: PostgresTelegramLikedByDeliveryStore;
  deliver: ReturnType<typeof createLikedByCustomerDelivery>;
  settle: (delivery: ClaimedTelegramLikedByDelivery) => Promise<boolean>;
  open: () => Promise<{ pay: string; full: ClaimedTelegramLikedByDelivery }>;
  texts: Parameters<TelegramLockedLikedByScreenRelay['sendPrivateText']>[0][];
  photos: Parameters<TelegramCandidateMediaRelay['send']>[0][];
  screens: {
    sendScreen: Mock<() => Promise<number>>;
    sendPrivateText: Mock<TelegramLockedLikedByScreenRelay['sendPrivateText']>;
  };
};
describe.skipIf(!url || !redisUrl)('original-session Liked By customer journey', () => {
  let db: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    redis: ReturnType<typeof createRedisConnection>;
  const key = Buffer.alloc(32, 61),
    botId = '12345',
    owner = 'liked-by-customer-proof';
  let update = 100;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_liked_by_delivery');
    await runMigrations(isolated.url, resolve('migrations'));
    db = createDatabase({
      url: isolated.url,
      poolMax: 12,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    redis = createRedisConnection(redisUrl!);
    await redis.connect();
  });
  afterAll(async () => {
    await redis?.quit();
    await db?.destroy();
    await isolated?.destroy();
  });
  async function fixture(reportsEnabled = true): Promise<Fixture> {
    const source = await createMediaAuthorityFixture(db, 'liked_by_blur'),
      now = new Date(),
      telegram = String(700000000000 + Math.floor(Math.random() * 100000000000)),
      prefix = 'liked-by-proof:' + randomUUID();
    // The low-level media fixture omits the sender's signup settings. Supply
    // that ordinary identity record, deliberately hidden: a sent Like survives it.
    await db
      .insertInto('identity.user_settings')
      .values({
        user_id: source.ownerUserId,
        visibility_enabled: false,
        ui_locale_code: 'en',
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('identity.telegram_identities')
      .values({
        user_id: source.actorUserId,
        telegram_user_id: telegram,
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    await db
      .insertInto('identity.guest_preview_counters')
      .values({
        user_id: source.actorUserId,
        preview_count: 0,
        limit_count: 3,
        first_preview_at: null,
        last_preview_at: null,
      })
      .execute();
    await db
      .insertInto('notification.notification_preferences')
      .values({ user_id: source.actorUserId, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('billing.credit_accounts')
      .values({ user_id: source.actorUserId, created_at: now, updated_at: now })
      .execute();
    await new PostgresCreditLedgerStore(db).append({
      transactionId: randomUUID(),
      userId: source.actorUserId,
      transactionType: 'admin_adjustment',
      amount: 100n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const grant = await new PostgresUserSessionStore(db).issue(
      { userId: source.actorUserId, productEpoch: 0 },
      randomUUID(),
    );
    if (!grant) throw new Error('Synthetic session unavailable');
    const actor: UserSessionActor = {
      kind: 'user',
      userId: source.actorUserId,
      productEpoch: 0,
      sessionGrantId: grant.id,
    };
    const menus: Array<Record<string, unknown>> = [],
      acks: string[] = [];
    const client = new TelegramBotApiMenuClient(`${botId}:${'a'.repeat(24)}`, (input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Synthetic request body unavailable');
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (input.endsWith('/sendMessage')) menus.push(body);
      else acks.push(String(body.callback_query_id));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true })));
    });
    const runtime = new TelegramLikedByCustomerRuntime(db, db, redis, prefix, botId, key, client, {
      consume: () => Promise.resolve({ allowed: true, remaining: 19, retryAfterSeconds: 0 }),
    });
    await runtime.onModuleInit();
    const callback = (data: string): ReturnType<TelegramLikedByCustomerRuntime['handle']> =>
      runtime.handle({
        update_id: update++,
        callback_query: {
          id: randomUUID(),
          data,
          from: { id: Number(telegram), is_bot: false },
          message: {
            chat: { id: Number(telegram), type: 'private' },
            from: { id: Number(botId), is_bot: true },
          },
        },
      });
    const store = new PostgresTelegramLikedByDeliveryStore(
      db,
      new SystemIdGenerator(),
      new SystemClock(),
    );
    const claim = async (): Promise<ClaimedTelegramLikedByDelivery> => {
      const requests = await store.claimBatch({ owner, leaseMs: 300000, limit: 100 });
      const request = requests.find((r) => r.viewerUserId === actor.userId);
      if (!request) throw new Error('Synthetic claim unavailable');
      return request;
    };
    const cards: Array<string> = [],
      texts: Parameters<TelegramLockedLikedByScreenRelay['sendPrivateText']>[0][] = [],
      photos: Parameters<TelegramCandidateMediaRelay['send']>[0][] = [];
    const screens = {
      sendScreen: vi.fn(() => Promise.resolve(1)),
      sendPrivateText: vi.fn(
        (input: Parameters<TelegramLockedLikedByScreenRelay['sendPrivateText']>[0]) => {
          texts.push(input);
          return Promise.resolve(200 + texts.length);
        },
      ),
    };
    const photoRelay = {
      send: vi.fn(
        async (
          input: Parameters<TelegramCandidateMediaRelay['send']>[0],
          before?: () => Promise<boolean>,
        ) => {
          if (before && !(await before())) throw new Error('Source denied');
          photos.push(input);
          return String(100 + photos.length);
        },
      ),
    };
    const deliver = createLikedByCustomerDelivery({
      database: db,
      environment: 'test',
      owner,
      botId,
      actionKey: key,
      mediaOrigin: 'https://media.example.test',
      reportsEnabled,
      tokens: (life) => new RedisOwnedOpaqueTokenStore(redis, prefix, life),
      signer: {
        sign: (source) => 'https://media.example.test' + source.path + '?token=synthetic.signature',
      },
      blur: { execute: () => Promise.resolve('/media/synthetic/blurred-preview-v1.webp') },
      store,
      renderers: new WorkerTelegramLikedByRendererProvider(
        new PostgresIdentityStore(db),
        new PostgresLocalizationStore(db),
      ),
      screens,
      cards: {
        sendCard: async (_viewer, _telegram, card, _render, before) => {
          if (before) await before();
          cards.push(card.unlock.callbackData);
          return 10 + cards.length;
        },
      },
      photos: photoRelay,
    });
    const settle = (delivery: ClaimedTelegramLikedByDelivery): Promise<boolean> =>
      store.markDelivered({ id: delivery.id, owner, attemptCount: delivery.attemptCount });
    const open = async (): ReturnType<Fixture['open']> => {
      const button = await runtime.entryButton(telegram, actor);
      expect(await callback(button.callback_data)).toBe('enqueued');
      const first = await claim();
      await deliver(first);
      await settle(first);
      expect(cards).toHaveLength(1);
      expect(await callback(cards[0]!)).toBe('notice');
      const menu = menus.at(-1)!,
        markup = menu.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
      const pay = markup.inline_keyboard[0]![0]!.callback_data;
      expect(await callback(pay)).toBe('enqueued');
      return { pay, full: await claim() };
    };
    return {
      source,
      actor,
      callback,
      store,
      deliver,
      settle,
      open,
      texts,
      photos,
      screens,
    };
  }
  async function report(f: Fixture, photo = false): Promise<SubmitReport> {
    const values = new Map<string, string>(),
      secret = Buffer.alloc(32, 62),
      tokens = ReportTokens.forLife(
        {
          get: (id) => Promise.resolve(values.get(id)),
          putIfAbsent: (id, value) => {
            if (values.has(id)) return Promise.resolve(false);
            values.set(id, value);
            return Promise.resolve(true);
          },
        },
        Buffer.alloc(32, 63),
        f.actor,
      );
    const services = createPostgresUserReportServices(
      db,
      tokens,
      photo
        ? {
            photo: {
              protector: new AesGcmPhotoReportSnapshotProtector('synthetic', 1, secret),
              reader: new AesGcmPhotoReportSnapshotReader({ resolve: () => secret }),
            },
          }
        : {
            profile: {
              protector: new AesGcmProfileReportSnapshotProtector('synthetic', 1, secret),
              reader: new AesGcmProfileReportSnapshotReader({ resolve: () => secret }),
            },
          },
      { actor: f.actor, receivedLikeId: f.source.likeId! },
    );
    const source = await tokens.issueSource(f.actor.userId, {
      kind: 'received_like',
      referenceId: f.source.likeId!,
      ...(photo ? { photoId: f.source.photoId } : {}),
    });
    const prepared = await services.prepare.execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        sourceActionToken: source.token,
        requestedEvidenceTypes: [photo ? 'photo' : 'profile'],
      },
      f.actor,
      0,
      f.actor.sessionGrantId,
    );
    const id = randomUUID(),
      command = {
        commandType: 'moderation.submit-report' as const,
        schemaVersion: 1 as const,
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        actor: { kind: 'user' as const, userId: f.actor.userId },
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { evidenceIntentToken: prepared.evidenceIntentToken, reasonCode: 'harassment' },
      };
    const submit: SubmitReport = () =>
      services.submit.execute(command, f.actor, 0, f.actor.sessionGrantId);
    expect((await submit()).replayed).toBe(false);
    expect((await submit()).replayed).toBe(true);
    return submit;
  }
  it('opens, unlocks once, resumes recorded full delivery and matches exactly once', async () => {
    const f = await fixture(),
      { pay, full } = await f.open();
    expect(await f.callback(pay)).toBe('enqueued');
    expect(
      await db
        .selectFrom('interaction.feature_unlocks')
        .select('id')
        .where('payer_user_id', '=', f.actor.userId)
        .execute(),
    ).toHaveLength(1);
    f.screens.sendPrivateText.mockRejectedValueOnce(
      new TelegramLikedBySendFailure('provider_unavailable'),
    );
    await expect(f.deliver(full)).rejects.toMatchObject({ reasonCode: 'provider_unavailable' });
    expect(f.photos).toHaveLength(1);
    await f.deliver(full);
    expect(f.photos).toHaveLength(1);
    expect(f.texts).toHaveLength(1);
    expect(f.photos[0]?.protectContent).toBe(true);
    expect(f.texts[0]?.text).toContain('Private report fixture');
    const receipts = await f.store.loadRecordedMessageKeys({
      id: full.id,
      owner,
      attemptCount: full.attemptCount,
    });
    expect(receipts).toHaveLength(2);
    expect(receipts?.every((r) => /^detail:[A-Za-z0-9_-]{43}$/u.test(r))).toBe(true);
    const callback = f.texts[0]!.keyboard[0]![0]!.callback_data;
    expect(await f.callback(callback)).toBe('notice');
    expect(await f.callback(callback)).toBe('notice');
    expect(
      await db
        .selectFrom('matching.matches')
        .select('id')
        .where((e) =>
          e.or([e('user_low_id', '=', f.actor.userId), e('user_high_id', '=', f.actor.userId)]),
        )
        .execute(),
    ).toHaveLength(1);
    // Safety reporting remains available for the exact historical Like after
    // Like Back closes it; it never reopens customer profile access.
    const replayReport = await report(f);
    await report(f, true);
    await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
    await new PostgresUserSessionStore(db).issue(
      { userId: f.actor.userId, productEpoch: 0 },
      randomUUID(),
    );
    await expect(replayReport()).rejects.toBeDefined();
    await f.settle(full);
  });
  it('rejects a queued original session after revocation despite a newer sign-in', async () => {
    const f = await fixture(),
      { full } = await f.open();
    await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
    await new PostgresUserSessionStore(db).issue(
      { userId: f.actor.userId, productEpoch: 0 },
      randomUUID(),
    );
    await expect(f.deliver(full)).rejects.toMatchObject({ status: 403 });
    expect(f.photos).toHaveLength(0);
    expect(f.texts).toHaveLength(0);
    await f.store.markFailed({
      id: full.id,
      owner,
      attemptCount: full.attemptCount,
      errorCode: 'identity_unavailable',
    });
  });
  it('keeps the profile usable when report delivery is disabled and dismisses only its exact Like', async () => {
    const f = await fixture(false),
      { full } = await f.open();
    await f.deliver(full);
    expect(f.texts[0]?.keyboard).toHaveLength(3);
    expect(
      f.photos[0]?.keyboard?.flat().every((button) => button.callback_data.startsWith('m9l:')),
    ).toBe(true);
    const dismiss = f.texts[0]!.keyboard[0]![1]!.callback_data;
    expect(await f.callback(dismiss)).toBe('notice');
    expect(await f.callback(dismiss)).toBe('notice');
    expect(
      await db
        .selectFrom('interaction.not_interested')
        .select('id')
        .where('sender_user_id', '=', f.actor.userId)
        .where('receiver_user_id', '=', f.source.ownerUserId)
        .execute(),
    ).toHaveLength(1);
    await f.settle(full);
  });
});
