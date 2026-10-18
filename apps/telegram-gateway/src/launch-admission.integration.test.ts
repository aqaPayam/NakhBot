import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  PostgresLaunchCohortControl,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramGatewayModule } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined || redisUrl === undefined)(
  'native staging gateway cohort admission',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      database: NakhDatabase,
      app: NestFastifyApplication;
    const sha = 'a'.repeat(40),
      operatorId = randomUUID(),
      sender = 8675309123;
    const sent: Parameters<TelegramBotApiMenuClient['sendMenu']>[1][] = [];
    const start = (id: number): Record<string, unknown> => ({
      update_id: id,
      message: {
        text: '/start',
        from: { id: sender, is_bot: false },
        chat: { id: sender, type: 'private' },
      },
    });
    const post = async (
      payload: object,
      secret = '1'.repeat(32),
    ): Promise<{ statusCode: number }> =>
      await app.inject({
        method: 'POST',
        url: '/v1/providers/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': secret },
        payload,
      });
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm9_gateway_cohort');
      await runMigrations(isolated.url, resolve('migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 4,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 5000,
      });
      vi.stubEnv('M9_COHORT_BOT', `12345:${'a'.repeat(24)}`);
      vi.stubEnv('M9_COHORT_KEY', Buffer.alloc(32, 83).toString('base64url'));
      vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockImplementation(
        (_recipient, menu) => {
          sent.push(structuredClone(menu));
          return Promise.resolve();
        },
      );
      vi.spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback').mockResolvedValue(undefined);
      const config = parseConfig({
        NAKH_ENV: 'staging',
        NAKH_RELEASE: sha,
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: redisUrl!,
        NAKH_QUEUE_PREFIX: `m9-cohort-${randomUUID()}`,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M9_COHORT_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
        NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF: 'M9_COHORT_KEY',
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
        NAKH_MEDIA_INGESTION_ENABLED: 'true',
        NAKH_MEDIA_TRANSPORT_KEY_REF: 'M9_COHORT_KEY',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'fixture',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M9_COHORT_KEY',
      });
      app = await NestFactory.create<NestFastifyApplication>(
        TelegramGatewayModule.register(config),
        new FastifyAdapter(),
        { logger: false },
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });
    afterAll(async () => {
      await app?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.destroy();
      await isolated?.destroy();
    });
    const grants = async (): Promise<{ id: string }[]> =>
      database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .execute();
    it('authenticates first and permits limited registration without issuing a product grant before explicit membership', async () => {
      expect((await post(start(1), 'wrong')).statusCode).toBe(401);
      expect(
        await database
          .selectFrom('identity.telegram_identities')
          .select('user_id')
          .where('telegram_user_id', '=', String(sender))
          .execute(),
      ).toHaveLength(0);
      expect((await post(start(2))).statusCode).toBe(201);
      expect(sent.at(-1)!.replyMarkup.inline_keyboard).toEqual([]);
      expect(sent.at(-1)!.text).toBe('This action is not available for your account.');
      expect(await grants()).toHaveLength(0);
    });
    it('opens the same native identity after approval and stops saved product navigation without renewing its grant', async () => {
      const identity = await database
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('telegram_user_id', '=', String(sender))
        .executeTakeFirstOrThrow();
      const control = new PostgresLaunchCohortControl(database, { operatorId });
      const input = {
        requestId: randomUUID(),
        expectedVersion: 0,
        sourceSha: sha,
        environment: 'staging' as const,
        telegramBotId: '12345',
        mode: 'cohort' as const,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        reviewDigest: 'b'.repeat(64),
        members: [{ userId: identity.user_id, productEpoch: 0 }],
      };
      await control.apply(input);
      expect((await post(start(3))).statusCode).toBe(201);
      const buttons = sent.at(-1)!.replyMarkup.inline_keyboard.flat();
      expect(buttons.length).toBeGreaterThan(0);
      expect(await grants()).toHaveLength(1);
      const data = buttons[0]!.callback_data;
      expect(typeof data).toBe('string');
      await control.apply({
        ...input,
        requestId: randomUUID(),
        expectedVersion: 1,
        mode: 'closed',
        expiresAt: null,
        members: [],
      });
      const before = sent.length;
      expect(
        (
          await post({
            update_id: 4,
            callback_query: {
              id: 'cohort-stopped',
              data,
              from: { id: sender, is_bot: false },
              message: {
                message_id: 1,
                chat: { id: sender, type: 'private' },
                from: { id: 12345, is_bot: true },
              },
            },
          })
        ).statusCode,
      ).toBe(201);
      expect(sent).toHaveLength(before);
      expect(await grants()).toHaveLength(1);
      expect((await post(start(5))).statusCode).toBe(201);
      expect(sent.at(-1)!.replyMarkup.inline_keyboard).toEqual([]);
      expect(await grants()).toHaveLength(1);
    });
  },
);
