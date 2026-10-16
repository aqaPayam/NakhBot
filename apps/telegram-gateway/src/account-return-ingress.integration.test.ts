import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, readdir, copyFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { createTelegramAccountDeletionIngress } from './account-deletion-ingress.js';
import { TelegramGatewayModule } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const botId = 12345,
  key = Buffer.alloc(32, 145),
  botToken = `${botId}:${'a'.repeat(24)}`;
let updateId = 300;
function message(sender: string, id = updateId++): Record<string, unknown> {
  return {
    update_id: id,
    message: {
      text: '/return',
      from: { id: Number(sender), is_bot: false },
      chat: { id: Number(sender), type: 'private' },
    },
  };
}
function callback(sender: string, data: string, id = updateId++): Record<string, unknown> {
  return {
    update_id: id,
    callback_query: {
      id: `return-callback-${id}`,
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
// Native Root/approval/grant/Return are real. Provider absence, protected MFA and
// operator drain are synthetic fixture observations; send/ack are test doubles.
describe.skipIf(url === undefined)('native Telegram original-grant approved Return', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let send: MockInstance<TelegramBotApiMenuClient['sendMenu']>,
    ack: MockInstance<TelegramBotApiMenuClient['answerCallback']>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_return_tg');
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
    send = vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockResolvedValue(undefined);
    ack = vi
      .spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback')
      .mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  function ingress(): ReturnType<typeof createTelegramAccountDeletionIngress> {
    return createTelegramAccountDeletionIngress({
      database,
      redis: {} as ReturnType<typeof createRedisConnection>,
      config: {
        deletion: {
          telegramEnabled: true,
          returnTelegramEnabled: true,
          confirmationKeyRef: 'key',
          confirmationKeyId: 'm8-tg',
        },
        telegram: { botTokenRef: 'bot' },
        redis: { queuePrefix: 'm8-return-native' },
      } as AppConfig,
      resolveSecret: (ref) => (ref === 'bot' ? botToken : key.toString('base64url')),
    });
  }
  function menu(): RenderedTelegramPhotoMenu {
    const n = send.mock.calls.at(-1)?.[1];
    if (n === undefined) throw new Error('missing Return menu');
    return n;
  }
  async function fixture(
    approve = true,
  ): Promise<Awaited<ReturnType<typeof createAccountReturnFixture>> & { telegramUserId: string }> {
    const f = await createAccountReturnFixture(database, { approve });
    const identity = await database
      .selectFrom('identity.telegram_identities')
      .select('telegram_user_id')
      .where('user_id', '=', f.userId)
      .executeTakeFirstOrThrow();
    return { ...f, telegramUserId: identity.telegram_user_id };
  }
  async function returned(userId: string): Promise<number> {
    return (
      await sql<{
        count: number;
      }>`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE event_type='account.returned.v1' AND actor_user_id=${userId}::uuid`.execute(
        database,
      )
    ).rows[0]!.count;
  }
  async function deleteNext(userId: string): Promise<void> {
    const life = { userId, productEpoch: 1 },
      grant = await new PostgresAccountControlSessionStore(database).issue(life, randomUUID()),
      account = await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
    const store = new PostgresAccountDeletionStore(
      database,
      { activeKeyId: 'next', keys: new Map([['next', Buffer.alloc(32, 146)]]) },
      { kind: 'user', scope: 'account_control', ...life, controlGrantId: grant!.id },
    );
    const proof = await store.prepare({
        actor: { kind: 'user', userId },
        requestId: randomUUID(),
        expectedAccountVersion: account.version,
      }),
      id = randomUUID();
    await store.request({
      commandId: id,
      commandType: 'account.delete',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { confirmationToken: proof.confirmationToken, expectedAccountVersion: account.version },
    });
  }
  it('renders owned short callbacks and commits once across twenty confirmations plus next-life replay', async () => {
    const f = await fixture(),
      handler = ingress(),
      update = message(f.telegramUserId);
    await handler.handle(update);
    const first = menu(),
      confirm = first.replyMarkup.inline_keyboard[0]![0]!.callback_data;
    expect(first.text).toContain('lifetime guest preview allowance');
    expect(Buffer.byteLength(confirm)).toBeLessThanOrEqual(64);
    expect(confirm).not.toContain(f.userId);
    await handler.handle(update);
    expect(menu()).toEqual(first);
    expect(await returned(f.userId)).toBe(0);
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () => handler.handle(callback(f.telegramUserId, confirm))),
      ),
    ).toEqual(Array.from({ length: 20 }, () => 'notice'));
    expect(await returned(f.userId)).toBe(1);
    expect(menu().text).toContain('Your return is complete');
    const grant = (
      await database
        .selectFrom('platform.audit_logs')
        .select('metadata')
        .where('event_type', '=', 'account.returned.v1')
        .where('actor_user_id', '=', f.userId)
        .executeTakeFirstOrThrow()
    ).metadata as { controlGrantId: string };
    expect(
      (
        await new PostgresAccountControlSessionStore(database).findForReturn(
          f.userId,
          grant.controlGrantId,
        )
      )?.productEpoch,
    ).toBe(0);
    expect(
      await new PostgresAccountControlSessionStore(database).current(
        { userId: f.userId, productEpoch: 0 },
        grant.controlGrantId,
      ),
    ).toBeUndefined();
    expect(
      (
        await database
          .selectFrom('identity.guest_preview_counters')
          .select('preview_count')
          .where('user_id', '=', f.userId)
          .executeTakeFirstOrThrow()
      ).preview_count,
    ).toBe(3);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'product_epoch'])
        .where('user_id', '=', f.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'guest', product_epoch: 1 });
    await handler.handle(callback(f.telegramUserId, confirm));
    expect(await returned(f.userId)).toBe(1);
    await handler.handle(update);
    expect(menu().text).toContain('not available');
    expect(await returned(f.userId)).toBe(1);
  });
  it('rejects foreign and modified callbacks and requires an independent native approval', async () => {
    const f = await fixture(false),
      other = await fixture(),
      handler = ingress();
    await handler.handle(message(f.telegramUserId));
    const buttons = menu().replyMarkup.inline_keyboard[0]!,
      confirm = buttons[0]!.callback_data;
    send.mockClear();
    ack.mockClear();
    await expect(handler.handle(callback(other.telegramUserId, confirm))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      handler.handle(callback(f.telegramUserId, confirm.replace(':y:', ':n:'))),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    await handler.handle(callback(f.telegramUserId, buttons[1]!.callback_data));
    expect(menu().text).toContain('No new return command');
    await handler.handle(callback(f.telegramUserId, confirm));
    expect(menu().text).toContain('not available');
    expect(await returned(f.userId)).toBe(0);
  });
  it('recovers a lost provider response and blocks delivery after a later tombstone during callback acknowledgment', async () => {
    const f = await fixture(),
      handler = ingress();
    await handler.handle(message(f.telegramUserId));
    const confirm = menu().replyMarkup.inline_keyboard[0]![0]!.callback_data;
    send.mockRejectedValueOnce(new Error('private token-bearing URL'));
    await expect(handler.handle(callback(f.telegramUserId, confirm))).rejects.toMatchObject({
      status: 500,
      message: 'error.deletion.unavailable',
    });
    expect(await returned(f.userId)).toBe(1);
    await handler.handle(callback(f.telegramUserId, confirm));
    expect(menu().text).toContain('Your return is complete');
    send.mockClear();
    ack.mockImplementationOnce(async () => {
      await deleteNext(f.userId);
    });
    await expect(handler.handle(callback(f.telegramUserId, confirm))).rejects.toMatchObject({
      status: 401,
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await sql`SELECT identity.account_return_completed(${f.recordId}::uuid) AS original,billing.deletion_credit_cutover_valid(${f.recordId}::uuid) AS financial`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ original: true, financial: true }]);
  });
  it('upgrades a completed approved schema-142 Root without changing its original facts', async () => {
    const target = await createIsolatedTestDatabase(url!, 'm8_return_text_upgrade'),
      directory = await mkdtemp(join(tmpdir(), 'm8-return-text-'));
    let legacy: NakhDatabase | undefined;
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 142)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(target.url, directory);
      legacy = createDatabase({
        url: target.url,
        poolMax: 4,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const f = await createAccountReturnFixture(legacy),
        before = (
          await sql`SELECT to_jsonb(root) AS original FROM identity.account_deletion_records root WHERE id=${f.recordId}::uuid`.execute(
            legacy,
          )
        ).rows;
      expect((await runMigrations(target.url, resolve('migrations'))).applied).toEqual([
        '000143_m8_return_localization.sql',
        '000144_m8_fresh_entry_localization.sql',
        '000145_m8_retention_policy.sql',
        '000146_m8_retained_source_membership.sql',
        '000147_m8_support_content_release.sql',
        '000148_m8_protected_profile_change_lives.sql',
        '000149_m8_live_retained_safety_holds.sql',
        '000150_m8_batched_photo_sources.sql',
        '000151_m8_minimal_review_response_receipts.sql',
        '000152_m9_signup_presentation.sql',
      ]);
      await verifyMigrations(target.url, resolve('migrations/verify'));
      expect(
        (
          await sql`SELECT to_jsonb(root) AS original FROM identity.account_deletion_records root WHERE id=${f.recordId}::uuid`.execute(
            legacy,
          )
        ).rows,
      ).toEqual(before);
      const id = randomUUID();
      expect(
        await new PostgresAccountReturnStore(legacy, f.control).return({
          commandId: id,
          commandType: 'account.return',
          schemaVersion: 1,
          actor: { kind: 'user', userId: f.userId },
          requestId: randomUUID(),
          idempotencyKey: id,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { expectedAccountVersion: f.version },
        }),
      ).toMatchObject({ returned: true, replayed: false });
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key LIKE 'return.%'`.execute(
            legacy,
          )
        ).rows,
      ).toEqual([{ count: 7 }]);
    } finally {
      await legacy?.destroy();
      await target.destroy();
      for (const file of await readdir(directory)) await rm(join(directory, file));
      await rmdir(directory);
    }
  });
  it.skipIf(redisUrl === undefined)(
    'routes authenticated webhooks through real Redis admission without resetting the limit after Return',
    async () => {
      vi.restoreAllMocks();
      send = vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockResolvedValue(undefined);
      vi.spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback').mockResolvedValue(undefined);
      const f = await fixture(),
        prefix = `m8-return-webhook-${randomUUID()}`,
        target = new URL(redisUrl!);
      target.pathname = '/15';
      vi.stubEnv('M8_RETURN_TG_BOT', botToken);
      vi.stubEnv('M8_RETURN_TG_KEY', key.toString('base64url'));
      const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: target.toString(),
        NAKH_QUEUE_PREFIX: prefix,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M8_RETURN_TG_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M8_RETURN_TG_KEY',
        NAKH_RETURN_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
        NAKH_DELETION_CONFIRMATION_KEY_REF: 'M8_RETURN_TG_KEY',
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
        const data = menu().replyMarkup.inline_keyboard[0]![0]!.callback_data;
        for (let n = 0; n < 10; n++)
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
        expect(await returned(f.userId)).toBe(1);
        expect(menu().text).toContain('Please wait');
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
