import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
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
import { parseConfig, type AppConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresAccountControlSessionStore,
  PostgresAccountDeletionStore,
  PostgresAccountReturnStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { RedisRateLimiter, createRedisConnection } from '@nakh/queue-redis';
import { TelegramBotApiMenuClient, type RenderedTelegramPhotoMenu } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
import {
  createTelegramAccountDeletionIngress,
  type TelegramAccountDeletionIngressPort,
} from './account-deletion-ingress.js';
import { TelegramGatewayModule } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const key = Buffer.alloc(32, 153),
  botId = 12345,
  botToken = `${botId}:${'a'.repeat(24)}`,
  prefix = 'm8-native-final';
let serial = 700;
function message(sender: string, id = serial++): Record<string, unknown> {
  return {
    update_id: id,
    message: {
      text: '/start',
      from: { id: Number(sender), is_bot: false },
      chat: { id: Number(sender), type: 'private' },
    },
  };
}
function callback(sender: string, data: string): Record<string, unknown> {
  const id = serial++;
  return {
    update_id: id,
    callback_query: {
      id: `entry-${id}`,
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
// Native grants, approval, Return and deletion are real. Original provider absence,
// protected factor/drain observations and Telegram delivery are synthetic fixtures.
describe.skipIf(url === undefined)('native authenticated fresh primary activation', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let send: MockInstance<TelegramBotApiMenuClient['sendMenu']>,
    ack: MockInstance<TelegramBotApiMenuClient['answerCallback']>;
  function providerMocks(): void {
    send = vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockResolvedValue(undefined);
    ack = vi
      .spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback')
      .mockResolvedValue(undefined);
  }
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_fresh_entry');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
    vi.spyOn(RedisRateLimiter.prototype, 'consume').mockResolvedValue({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 0,
    });
    providerMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function fixture(): Promise<
    Awaited<ReturnType<typeof createAccountReturnFixture>> & { telegramUserId: string }
  > {
    const f = await createAccountReturnFixture(database),
      id = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: f.userId },
      requestId: id,
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: f.version },
    });
    const identity = await database
      .selectFrom('identity.telegram_identities')
      .select('telegram_user_id')
      .where('user_id', '=', f.userId)
      .executeTakeFirstOrThrow();
    return { ...f, telegramUserId: identity.telegram_user_id };
  }
  function ingress(
    redis: ReturnType<typeof createRedisConnection>,
    namespace = prefix,
  ): TelegramAccountDeletionIngressPort {
    return createTelegramAccountDeletionIngress({
      database,
      redis,
      config: {
        deletion: {
          telegramEnabled: true,
          returnTelegramEnabled: true,
          freshEntryTelegramEnabled: true,
          confirmationKeyRef: 'key',
          confirmationKeyId: 'entry',
        },
        telegram: { botTokenRef: 'bot' },
        redis: { queuePrefix: namespace },
      } as AppConfig,
      resolveSecret: (r) => (r === 'bot' ? botToken : key.toString('base64url')),
    });
  }
  function menu(): RenderedTelegramPhotoMenu {
    const n = send.mock.calls.at(-1)?.[1];
    if (n === undefined) throw Error('missing menu');
    if (
      n.replyMarkup.inline_keyboard.some((row) =>
        row.some((button) => typeof button.callback_data !== 'string' || button.url !== undefined),
      )
    )
      throw new Error('Fresh-entry confirmations require callback buttons.');
    return n as RenderedTelegramPhotoMenu;
  }
  function confirmation(): string {
    return menu().replyMarkup.inline_keyboard[0]![0]!.callback_data;
  }
  async function snapshot(
    f: Awaited<ReturnType<typeof fixture>>,
  ): Promise<readonly Record<string, unknown>[]> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT to_jsonb(a) AS account,to_jsonb(root) AS root,to_jsonb(c) AS credit,to_jsonb(counter) AS preview,identity.account_return_completed(root.id) AS valid,billing.deletion_credit_cutover_valid(root.id) AS financial FROM identity.accounts a JOIN identity.account_deletion_records root ON root.id=${f.recordId}::uuid JOIN billing.credit_accounts c ON c.user_id=a.user_id JOIN identity.guest_preview_counters counter ON counter.user_id=a.user_id WHERE a.user_id=${f.userId}::uuid`.execute(
        database,
      )
    ).rows;
  }
  async function deleteNext(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
    const life = { userId: f.userId, productEpoch: 1 },
      grant = await new PostgresAccountControlSessionStore(database).issue(life, randomUUID());
    const store = new PostgresAccountDeletionStore(
      database,
      { activeKeyId: 'entry', keys: new Map([['entry', key]]) },
      { kind: 'user', scope: 'account_control', ...life, controlGrantId: grant!.id },
    );
    const prepared = await store.prepare({
        actor: { kind: 'user', userId: f.userId },
        requestId: randomUUID(),
        expectedAccountVersion: f.version + 1,
      }),
      id = randomUUID();
    await store.request({
      commandId: id,
      commandType: 'account.delete',
      schemaVersion: 1,
      actor: { kind: 'user', userId: f.userId },
      requestId: id,
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        expectedAccountVersion: prepared.expectedAccountVersion,
        confirmationToken: prepared.confirmationToken,
      },
    });
  }
  it('requires explicit fresh confirmation and keeps one current grant across twenty retries with all original proof intact', async () => {
    const f = await fixture(),
      before = await snapshot(f),
      evaluate = vi.fn(() => Promise.resolve(1)),
      port = ingress({ eval: evaluate } as unknown as ReturnType<typeof createRedisConnection>),
      update = message(f.telegramUserId);
    await port.handle(update);
    const data = confirmation();
    expect(menu().text).toContain('Confirm to activate');
    expect(evaluate).not.toHaveBeenCalled();
    await port.handle(update);
    expect(confirmation()).toBe(data);
    await Promise.all(
      Array.from({ length: 20 }, () => port.handle(callback(f.telegramUserId, data))),
    );
    expect(evaluate).toHaveBeenCalledTimes(20);
    expect(menu().text).toContain('ready');
    expect(await snapshot(f)).toEqual(before);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE event_type='identity.account-control-issued.v1' AND actor_user_id=${f.userId}::uuid AND metadata->'productEpoch'='1'::jsonb`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE event_type='identity.user-session-issued.v1' AND actor_user_id=${f.userId}::uuid AND metadata->'productEpoch'='1'::jsonb`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it('denies a foreign callback, wrong namespace and revoked grant before reporting success', async () => {
    const f = await fixture(),
      other = await fixture(),
      evaluate = vi.fn(() => Promise.resolve(1)),
      redis = { eval: evaluate } as unknown as ReturnType<typeof createRedisConnection>,
      port = ingress(redis);
    await port.handle(message(f.telegramUserId));
    const data = confirmation();
    send.mockClear();
    await expect(port.handle(callback(other.telegramUserId, data))).rejects.toMatchObject({
      status: 400,
    });
    expect(send).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    await expect(
      ingress(redis, 'wrong-namespace').handle(callback(f.telegramUserId, data)),
    ).rejects.toMatchObject({ status: 500 });
    expect(evaluate).not.toHaveBeenCalled();
    const grant = await database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('event_type', '=', 'identity.account-control-issued.v1')
      .where('actor_user_id', '=', f.userId)
      .where(sql<boolean>`metadata->'productEpoch'='1'::jsonb`)
      .executeTakeFirstOrThrow();
    await new PostgresAccountControlSessionStore(database).revoke(
      { userId: f.userId, productEpoch: 1 },
      grant.id,
      randomUUID(),
    );
    await port.handle(callback(f.telegramUserId, data));
    expect(menu().text).toContain('not available');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('checks the actual current life again after callback acknowledgement and denies the next tombstone', async () => {
    const f = await fixture(),
      evaluate = vi.fn(() => Promise.resolve(1)),
      port = ingress({ eval: evaluate } as unknown as ReturnType<typeof createRedisConnection>);
    await port.handle(message(f.telegramUserId));
    const data = confirmation();
    send.mockClear();
    ack.mockImplementationOnce(() => deleteNext(f));
    await expect(port.handle(callback(f.telegramUserId, data))).rejects.toMatchObject({
      status: 401,
    });
    expect(send).not.toHaveBeenCalled();
    await expect(port.handle(callback(f.telegramUserId, data))).rejects.toMatchObject({
      status: 401,
    });
    expect(
      (
        await sql`SELECT identity.account_return_completed(${f.recordId}::uuid) AS valid,billing.deletion_credit_cutover_valid(${f.recordId}::uuid) AS financial`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true, financial: true }]);
  });
  it.skipIf(redisUrl === undefined)(
    'uses the real authenticated webhook and Redis CAS, preserves the permanent budget and copies no old body',
    async () => {
      vi.restoreAllMocks();
      providerMocks();
      const f = await fixture(),
        target = new URL(redisUrl!);
      target.pathname = '/15';
      const redis = createRedisConnection(target.toString()),
        scope = `${prefix}:owned-action:{${createHash('sha256').update(f.userId).digest('hex')}}`,
        marker = `${scope}:life`;
      let app: NestFastifyApplication | undefined;
      try {
        await redis.set(marker, 'blocked:0');
        vi.stubEnv('M8_ENTRY_BOT', botToken);
        vi.stubEnv('M8_ENTRY_KEY', key.toString('base64url'));
        const config = parseConfig({
          NAKH_ENV: 'test',
          NAKH_SERVICE_NAME: 'telegram-gateway',
          NAKH_DATABASE_URL: isolated.url,
          NAKH_REDIS_URL: target.toString(),
          NAKH_QUEUE_PREFIX: prefix,
          NAKH_TELEGRAM_BOT_TOKEN_REF: 'M8_ENTRY_BOT',
          NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
          NAKH_R2_ENDPOINT: 'https://r2.invalid',
          NAKH_R2_BUCKET: 'test',
          NAKH_R2_ACCESS_KEY_REF: 'fake',
          NAKH_R2_SECRET_KEY_REF: 'fake',
          NAKH_MEDIA_CDN_HOST: 'media.invalid',
          NAKH_MEDIA_SIGNING_KEY_REF: 'M8_ENTRY_KEY',
          NAKH_FRESH_ENTRY_TELEGRAM_ENABLED: 'true',
          NAKH_RETURN_TELEGRAM_ENABLED: 'true',
          NAKH_DELETION_TELEGRAM_ENABLED: 'true',
          NAKH_DELETION_WORKER_ENABLED: 'true',
          NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
          NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
          NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
          NAKH_DELETION_CONFIRMATION_KEY_REF: 'M8_ENTRY_KEY',
        });
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
        const data = confirmation();
        expect(await redis.get(marker)).toBe('blocked:0');
        for (let i = 0; i < 10; i++)
          expect(
            (
              await app.inject({
                method: 'POST',
                url: route,
                headers,
                payload: callback(f.telegramUserId, data),
              })
            ).statusCode,
          ).toBe(201);
        expect(await redis.get(marker)).toBe('active:1');
        expect(await redis.pttl(marker)).toBe(-1);
        expect(menu().text).toContain('Please wait');
        expect(await redis.exists(`${scope}:0:index`, `${scope}:1:index`)).toBe(0);
        expect((await snapshot(f))[0]).toMatchObject({ valid: true, financial: true });
      } finally {
        await app?.close();
        await redis.unlink(marker, `${scope}:0:index`, `${scope}:1:index`);
        await redis.quit();
      }
    },
  );
  it.skipIf(redisUrl === undefined)(
    'recovers a lost real Redis response without restoring bodies and refuses a later blocked marker',
    async () => {
      const f = await fixture(),
        target = new URL(redisUrl!);
      target.pathname = '/15';
      const redis = createRedisConnection(target.toString()),
        scope = `${prefix}:owned-action:{${createHash('sha256').update(f.userId).digest('hex')}}`,
        marker = `${scope}:life`,
        port = ingress(redis);
      try {
        await redis.set(marker, 'blocked:0');
        await port.handle(message(f.telegramUserId));
        const data = confirmation(),
          evaluate = redis.eval.bind(redis);
        vi.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
          await evaluate(...args);
          throw Error('synthetic response loss after real CAS');
        });
        await expect(port.handle(callback(f.telegramUserId, data))).rejects.toMatchObject({
          status: 500,
        });
        expect(await redis.get(marker)).toBe('active:1');
        await port.handle(callback(f.telegramUserId, data));
        expect(menu().text).toContain('ready');
        expect(await redis.exists(`${scope}:0:index`, `${scope}:1:index`)).toBe(0);
        // Synthetic later marker observation; this case does not claim another
        // completed cleanup. The native case above performs the actual tombstone.
        await redis.set(marker, 'blocked:1');
        await expect(port.handle(callback(f.telegramUserId, data))).rejects.toMatchObject({
          status: 500,
        });
        expect(await redis.get(marker)).toBe('blocked:1');
      } finally {
        await redis.unlink(marker, `${scope}:0:index`, `${scope}:1:index`);
        await redis.quit();
      }
    },
  );
});
