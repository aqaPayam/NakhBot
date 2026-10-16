import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseConfig, type AppConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  PostgresIdentityStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramBotApiMenuClient, TelegramStartAdapter } from '@nakh/telegram';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramGatewayModule } from './app.js';
import { createTelegramStartDelivery } from './start-delivery.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const botToken = `12345:${'a'.repeat(24)}`;
let serial = 100000;
function start(sender: number, id = serial++): Record<string, unknown> {
  return {
    update_id: id,
    message: {
      text: '/start',
      from: { id: sender, is_bot: false },
      chat: { id: sender, type: 'private' },
    },
  };
}
// Telegram delivery is synthetic. Registration, replay and catalog lookup use
// migrated PostgreSQL; the composed webhook case also uses real Redis admission.
describe.skipIf(url === undefined)('native startup delivery', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let send: MockInstance<TelegramBotApiMenuClient['sendMenu']>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_start_delivery');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  beforeEach(() => {
    send = vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  function port(): ReturnType<typeof createTelegramStartDelivery> {
    return createTelegramStartDelivery({
      database,
      config: { telegram: { startDeliveryEnabled: true, botTokenRef: 'bot' } } as AppConfig,
      adapter: TelegramStartAdapter.withStore(new PostgresIdentityStore(database)),
      resolveSecret: () => botToken,
    });
  }
  it('keeps one native registration across ten concurrent retries and delivers a localized title', async () => {
    const sender = serial++,
      update = start(sender),
      ingress = port();
    const results = await Promise.all(Array.from({ length: 10 }, () => ingress.handle(update)));
    expect(results.filter((r) => r.handled && !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.handled && r.view.route === 'guest')).toBe(true);
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('telegram_user_id', '=', String(sender))
        .execute(),
    ).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(10);
    expect(
      send.mock.calls.every(
        ([recipient, menu]) =>
          recipient === String(sender) &&
          menu.text === 'Welcome to Nakh' &&
          menu.replyMarkup.inline_keyboard.length === 0,
      ),
    ).toBe(true);
  });
  it('re-reads native account routing when an old successful update is replayed', async () => {
    const sender = serial++,
      update = start(sender),
      ingress = port();
    const first = await ingress.handle(update);
    if (!first.handled) throw Error('Missing registration');
    // Synthetic account restriction establishes a newer native route; this is
    // not claimed as an end-to-end administrator moderation action.
    await database
      .updateTable('identity.accounts')
      .set({ state: 'restricted', version: 2 })
      .where('user_id', '=', first.userId)
      .execute();
    const replay = await ingress.handle(update);
    expect(replay).toMatchObject({ handled: true, replayed: true, view: { route: 'restricted' } });
    expect(send.mock.calls.at(-1)?.[1].text).toBe('Your account currently has limited access.');
  });
  it('retries provider failure without duplicating registration or exposing provider details', async () => {
    const sender = serial++,
      update = start(sender),
      ingress = port();
    send.mockRejectedValueOnce(Error(`https://api.telegram.org/bot${botToken}/sendMessage`));
    await expect(ingress.handle(update)).rejects.toMatchObject({
      status: 500,
      message: 'error.identity.user_context_invalid',
    });
    expect(await ingress.handle(update)).toMatchObject({ handled: true, replayed: true });
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('telegram_user_id', '=', String(sender))
        .execute(),
    ).toHaveLength(1);
  });
  it.skipIf(redisUrl === undefined)(
    'composes delivery in the actual authenticated webhook and rejects group starts before registration',
    async () => {
      vi.stubEnv('M9_START_BOT', botToken);
      const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: redisUrl!,
        NAKH_QUEUE_PREFIX: `m9-start-${randomUUID()}`,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M9_START_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M9_UNUSED_KEY',
      });
      let app: NestFastifyApplication | undefined;
      try {
        app = await NestFactory.create<NestFastifyApplication>(
          TelegramGatewayModule.register(config),
          new FastifyAdapter(),
          { logger: false },
        );
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        const sender = serial++,
          payload = start(sender),
          route = '/v1/providers/telegram/webhook',
          headers = { 'x-telegram-bot-api-secret-token': '1'.repeat(32) };
        expect((await app.inject({ method: 'POST', url: route, payload })).statusCode).toBe(401);
        expect(send).not.toHaveBeenCalled();
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: {
                ...payload,
                message: {
                  text: '/start',
                  from: { id: sender, is_bot: false },
                  chat: { id: sender, type: 'group' },
                },
              },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          await database
            .selectFrom('identity.telegram_identities')
            .select('user_id')
            .where('telegram_user_id', '=', String(sender))
            .execute(),
        ).toHaveLength(0);
        expect(
          (await app.inject({ method: 'POST', url: route, headers, payload })).statusCode,
        ).toBe(201);
        expect(send).toHaveBeenCalledExactlyOnceWith(String(sender), {
          text: 'Welcome to Nakh',
          replyMarkup: { inline_keyboard: [] },
        });
      } finally {
        await app?.close();
      }
    },
  );
});
