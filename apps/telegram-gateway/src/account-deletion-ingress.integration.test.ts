import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
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
import type { RegisterTelegramIdentityWrite } from '@nakh/application';
import { parseConfig, type AppConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresIdentityStore,
  PostgresTelegramUserResolver,
  PostgresAccountControlSessionStore,
  PostgresLocalizationStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { RedisRateLimiter, createRedisConnection } from '@nakh/queue-redis';
import { TelegramBotApiMenuClient, type RenderedTelegramPhotoMenu } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createFinalDeletionFixture } from '../../../packages/persistence-postgres/src/testing/final-deletion-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from '../../../packages/persistence-postgres/src/account-deletion-ephemeral-store.js';
import { createTelegramAccountDeletionIngress } from './account-deletion-ingress.js';
import { TelegramGatewayModule } from './app.js';
function start(telegramId: string): RegisterTelegramIdentityWrite {
  const id = randomUUID(),
    at = new Date();
  return {
    command: {
      commandId: id,
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
      requestId: randomUUID(),
      idempotencyKey: `m8-native:${id}`,
      occurredAt: at.toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: telegramId },
      data: { telegramUserId: telegramId, updateId: id, username: 'before_deletion' },
    },
    userId: randomUUID(),
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    registrationEventId: randomUUID(),
    startRouteEventId: randomUUID(),
    processedAt: at,
    guestPreviewLimit: 10,
    defaultLocale: 'en',
  };
}

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const botId = 12345,
  key = Buffer.alloc(32, 121),
  botToken = `${botId}:${'a'.repeat(24)}`;
let nextUpdate = 100;
function message(
  sender: string,
  text = '/delete',
  updateId = nextUpdate++,
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      text,
      from: { id: Number(sender), is_bot: false },
      chat: { id: Number(sender), type: 'private' },
    },
  };
}
function callback(sender: string, data: string, updateId = nextUpdate++): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data,
      from: { id: Number(sender), is_bot: false },
      message: {
        message_id: 1,
        from: { id: botId, is_bot: true },
        chat: { id: Number(sender), type: 'private' },
      },
    },
  };
}
describe.skipIf(url === undefined)('native trusted Telegram limited deletion composition', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    send: MockInstance<TelegramBotApiMenuClient['sendMenu']>,
    rate: MockInstance<RedisRateLimiter['consume']>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_telegram_deletion');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  beforeEach(() => {
    rate = vi.spyOn(RedisRateLimiter.prototype, 'consume').mockResolvedValue({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 0,
    });
    send = vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockResolvedValue(undefined);
    vi.spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function registered(): Promise<{ userId: string; telegramUserId: string }> {
    const telegramUserId = String(
        1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000),
      ),
      write = start(telegramUserId);
    await new PostgresIdentityStore(database).registerTelegramIdentity(write);
    return { userId: write.userId, telegramUserId };
  }
  function ingress(): ReturnType<typeof createTelegramAccountDeletionIngress> {
    return createTelegramAccountDeletionIngress({
      database,
      redis: {} as ReturnType<typeof createRedisConnection>,
      config: {
        deletion: { telegramEnabled: true, confirmationKeyRef: 'key', confirmationKeyId: 'm8-tg' },
        telegram: { botTokenRef: 'bot' },
        redis: { queuePrefix: 'm8-native-tg' },
      } as AppConfig,
      resolveSecret: (reference) => (reference === 'bot' ? botToken : key.toString('base64url')),
    });
  }
  function menu(): RenderedTelegramPhotoMenu {
    const result = send.mock.calls.at(-1)?.[1];
    expect(result).toBeDefined();
    if (
      result === undefined ||
      result.replyMarkup.inline_keyboard.some((row) =>
        row.some((button) => typeof button.callback_data !== 'string' || button.url !== undefined),
      )
    )
      throw new Error('Deletion confirmations require callback buttons.');
    return result as RenderedTelegramPhotoMenu;
  }
  async function roots(userId: string): Promise<number> {
    return (
      await sql<{
        count: number;
      }>`SELECT count(*)::integer AS count FROM identity.account_deletion_records WHERE user_id=${userId}::uuid`.execute(
        database,
      )
    ).rows[0]!.count;
  }
  async function corruptEpoch(userId: string): Promise<void> {
    await database.transaction().execute(async (tx) => {
      await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
      try {
        await tx
          .updateTable('identity.accounts')
          .set({ product_epoch: 1 })
          .where('user_id', '=', userId)
          .execute();
      } finally {
        await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
      }
    });
  }
  it('replays twenty primary preparations and twenty exact confirmations with one native Root and minimal deleted status', async () => {
    const f = await registered(),
      handler = ingress(),
      update = message(f.telegramUserId);
    const preparations = await Promise.all(
      Array.from({ length: 20 }, () => handler.handle(update)),
    );
    expect(preparations.every((x) => x === 'notice')).toBe(true);
    const buttons = send.mock.calls.map(
      (c) => c[1].replyMarkup.inline_keyboard[0]?.[0]?.callback_data,
    );
    expect(new Set(buttons).size).toBe(1);
    const confirm = buttons[0]!;
    expect(Buffer.byteLength(confirm)).toBeLessThanOrEqual(64);
    const receipts = await Promise.all(
      Array.from({ length: 20 }, () => handler.handle(callback(f.telegramUserId, confirm))),
    );
    expect(receipts.every((x) => x === 'notice')).toBe(true);
    expect(await roots(f.userId)).toBe(1);
    const resolver = new PostgresTelegramUserResolver(database);
    expect(await resolver.resolveProductLife(f.telegramUserId)).toBeUndefined();
    expect(await resolver.resolveAccountControlLife(f.telegramUserId)).toMatchObject({
      userId: f.userId,
      productEpoch: 0,
      accountVersion: 2,
    });
    expect(await handler.handle(message(f.telegramUserId, '/delete_status'))).toBe('notice');
    expect(menu().text).toContain('Cleanup is in progress');
    expect(menu().replyMarkup.inline_keyboard).toEqual([]);
    expect(menu().text).not.toContain(f.userId);
    expect(menu().text).not.toContain(confirm);
  });
  it('binds confirmations to their owner and cancels the exact proof idempotently', async () => {
    const f = await registered(),
      other = await registered(),
      handler = ingress();
    await handler.handle(message(f.telegramUserId));
    const buttons = menu().replyMarkup.inline_keyboard[0]!;
    await handler.handle(callback(other.telegramUserId, buttons[0]!.callback_data));
    expect(menu().text).toContain('unavailable');
    expect(await roots(other.userId)).toBe(0);
    expect(await roots(f.userId)).toBe(0);
    const cancelled = await Promise.all(
      Array.from({ length: 20 }, () =>
        handler.handle(callback(f.telegramUserId, buttons[1]!.callback_data)),
      ),
    );
    expect(cancelled.every((x) => x === 'notice')).toBe(true);
    expect(menu().text).toBe('That deletion confirmation was cancelled.');
    await handler.handle(callback(f.telegramUserId, buttons[0]!.callback_data));
    expect(menu().text).toContain('unavailable');
    expect(await roots(f.userId)).toBe(0);
  });
  it('cannot refresh an original update into a later life after privileged epoch corruption (not approved Return)', async () => {
    const f = await registered(),
      handler = ingress(),
      original = message(f.telegramUserId);
    await handler.handle(original);
    await corruptEpoch(f.userId);
    await handler.handle(original);
    expect(menu().text).toContain('unavailable');
    expect(await roots(f.userId)).toBe(0);
    expect(
      (
        await sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE actor_user_id=${f.userId}::uuid AND event_type='identity.account-control-issued.v1'`.execute(
          database,
        )
      ).rows[0]!.count,
    ).toBe(1);
  });
  it('does not enrich life captured before a limiter wait or deliver across a privileged epoch change', async () => {
    const f = await registered(),
      handler = ingress();
    let release!: () => void, observed!: () => void;
    const wait = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        observed = r;
      });
    rate.mockImplementationOnce(async () => {
      observed();
      await wait;
      return { allowed: true, remaining: 9, retryAfterSeconds: 0 };
    });
    const pending = handler.handle(message(f.telegramUserId)).then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      await started;
      await corruptEpoch(f.userId);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ status: 401 });
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await sql`SELECT id FROM identity.deletion_confirmations WHERE user_id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('rechecks native revocation after catalog loading and refuses stale delivery', async () => {
    const f = await registered(),
      handler = ingress(),
      source = new PostgresLocalizationStore(database),
      load = source.loadActiveCatalog.bind(source);
    vi.spyOn(PostgresLocalizationStore.prototype, 'loadActiveCatalog').mockImplementationOnce(
      async (locale) => {
        const catalog = await load(locale),
          grant = await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('actor_user_id', '=', f.userId)
            .where('event_type', '=', 'identity.account-control-issued.v1')
            .executeTakeFirstOrThrow();
        await new PostgresAccountControlSessionStore(database).revoke(
          { userId: f.userId, productEpoch: 0 },
          grant.id,
          randomUUID(),
        );
        return catalog;
      },
    );
    await expect(handler.handle(message(f.telegramUserId))).rejects.toMatchObject({ status: 401 });
    expect(send).not.toHaveBeenCalled();
  });
  it('recovers from a private provider failure after native commit without repeating deletion', async () => {
    const f = await registered(),
      handler = ingress();
    await handler.handle(message(f.telegramUserId));
    const confirm = menu().replyMarkup.inline_keyboard[0]![0]!.callback_data,
      update = callback(f.telegramUserId, confirm);
    send.mockRejectedValueOnce(new Error('private provider URL and token'));
    await expect(handler.handle(update)).rejects.toMatchObject({
      status: 500,
      message: 'error.deletion.unavailable',
    });
    expect(await roots(f.userId)).toBe(1);
    expect(await handler.handle(update)).toBe('notice');
    expect(await roots(f.userId)).toBe(1);
    expect(menu().text).not.toContain('private provider');
  });
  describe('limited status after complete product cleanup', () => {
    let completed: Awaited<ReturnType<typeof createFinalDeletionFixture>>;
    beforeEach(async () => {
      // Real native checkpoints with explicit empty-provider fixture observations;
      // this is not evidence of actual Redis absence or an operator drain.
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
        database,
      );
      completed = await createFinalDeletionFixture(database);
      const store = new PostgresAccountDeletionEphemeralStore(
        database,
        'm8-native-final',
        'a'.repeat(64),
      );
      for (let i = 0; i < 20; i++) {
        const next = await store.claimNext(completed.lease);
        if (next.done) break;
        const op = next.operation!;
        await store.complete(completed.lease, op.id, {
          cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
          more: false,
          found: 0,
        });
      }
      expect(await store.finish(completed.lease)).toEqual({ completed: true });
    });
    it('issues only limited status after settings purge while historical native proof remains valid', async () => {
      const identity = await database
        .selectFrom('identity.telegram_identities')
        .select('telegram_user_id')
        .where('user_id', '=', completed.userId)
        .executeTakeFirstOrThrow();
      const handler = ingress();
      expect(await handler.handle(message(identity.telegram_user_id, '/delete_status'))).toBe(
        'notice',
      );
      expect(menu().text).toBe(
        'Your account deletion is complete. Returning is unavailable for this account.',
      );
      expect(
        await new PostgresTelegramUserResolver(database).resolveProductLife(
          identity.telegram_user_id,
        ),
      ).toBeUndefined();
      expect(
        (
          await sql<{
            blocked: string | null;
          }>`SELECT identity.deletion_verification_blocker(${completed.recordId}::uuid,${completed.userId}::uuid) AS blocked`.execute(
            database,
          )
        ).rows[0]!.blocked,
      ).toBeNull();
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT bool_and(identity.retention_record_valid(r)) AS valid FROM identity.data_retention_records r WHERE deletion_record_id=${completed.recordId}::uuid`.execute(
            database,
          )
        ).rows[0]!.valid,
      ).toBe(true);
    });
  });
  it.skipIf(redisUrl === undefined)(
    'routes the real authenticated webhook through production composition and real Redis limits',
    async () => {
      vi.restoreAllMocks();
      send = vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockResolvedValue(undefined);
      vi.spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback').mockResolvedValue(undefined);
      const f = await registered(),
        prefix = `m8-webhook-delete-${randomUUID()}`,
        target = new URL(redisUrl!);
      target.pathname = '/15';
      vi.stubEnv('M8_DELETE_BOT', botToken);
      vi.stubEnv('M8_DELETE_KEY', key.toString('base64url'));
      const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: target.toString(),
        NAKH_QUEUE_PREFIX: prefix,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M8_DELETE_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.example.com',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M8_DELETE_KEY',
        NAKH_DELETION_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
        NAKH_DELETION_CONFIRMATION_KEY_REF: 'M8_DELETE_KEY',
      });
      // Configured drain hash is synthetic; provider send/ack are test doubles.
      let app: NestFastifyApplication | undefined;
      try {
        app = await NestFactory.create<NestFastifyApplication>(
          TelegramGatewayModule.register(config),
          new FastifyAdapter(),
          { logger: false },
        );
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        const route = '/v1/providers/telegram/webhook',
          headers = { 'x-telegram-bot-api-secret-token': '1'.repeat(32) };
        expect(
          (await app.inject({ method: 'POST', url: route, payload: message(f.telegramUserId) }))
            .statusCode,
        ).toBe(401);
        expect(send).not.toHaveBeenCalled();
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: message(f.telegramUserId),
            })
          ).statusCode,
        ).toBe(201);
        const confirm = menu().replyMarkup.inline_keyboard[0]![0]!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(f.telegramUserId, confirm),
            })
          ).statusCode,
        ).toBe(201);
        expect(await roots(f.userId)).toBe(1);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: message(f.telegramUserId, '/delete_status'),
            })
          ).statusCode,
        ).toBe(201);
        expect(menu().text).toContain('Cleanup is in progress');
      } finally {
        await app?.close();
        const redis = createRedisConnection(target.toString());
        try {
          let cursor = '0';
          do {
            const page = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
            cursor = page[0];
            if (page[1].length) await redis.unlink(...page[1]);
          } while (cursor !== '0');
        } finally {
          await redis.quit();
        }
      }
    },
  );
});
