import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresLaunchCohortControl,
  PostgresFreeTestCreditModeControl,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import { referenceFixtureConfig } from '../../../packages/persistence-postgres/src/testing/release-reference-config.js';
import { createReportUser } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramAccountRuntime } from './account-runtime.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined || redisUrl === undefined)(
  'account credits through native storage and bot serialization',
  () => {
    let database: NakhDatabase,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      redis: ReturnType<typeof createRedisConnection>;
    let runtime: TelegramAccountRuntime, userId: string;
    let serial = 50000;
    type Menu = {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    const menus: Menu[] = [];
    const sender = 73334123;
    const incoming = (text: string): unknown => ({
      update_id: serial++,
      message: {
        message_id: serial++,
        text,
        from: { id: sender, is_bot: false },
        chat: { id: sender, type: 'private' },
      },
    });
    const callback = (data: string, from = sender): unknown => ({
      update_id: serial++,
      callback_query: {
        id: String(serial++),
        data,
        from: { id: from, is_bot: false },
        message: {
          message_id: 1,
          from: { id: 12345, is_bot: true },
          chat: { id: from, type: 'private' },
        },
      },
    });
    const latest = (): Menu => menus.at(-1)!;
    const button = (text: string): string =>
      latest()
        .reply_markup.inline_keyboard.flat()
        .find((b) => b.text === text)!.callback_data;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'nakh_account_credits');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 20000,
      });
      redis = createRedisConnection(redisUrl!);
      userId = await createReportUser(database, true);
      const now = new Date();
      await database
        .insertInto('billing.credit_accounts')
        .values({ user_id: userId, created_at: now, updated_at: now })
        .execute();
      await database
        .insertInto('identity.user_settings')
        .values({ user_id: userId, created_at: now, updated_at: now })
        .execute();
      await database
        .insertInto('identity.guest_preview_counters')
        .values({ user_id: userId, limit_count: 10, first_preview_at: null, last_preview_at: null })
        .execute();
      await database
        .insertInto('identity.telegram_identities')
        .values({
          user_id: userId,
          telegram_user_id: String(sender),
          username: null,
          first_seen_at: now,
          last_seen_at: now,
        })
        .execute();
      const audience = {
          sourceSha: 'a'.repeat(40),
          environment: 'staging' as const,
          telegramBotId: '12345',
        },
        policyId = randomUUID(),
        expiresAt = new Date(Date.now() + 3600000).toISOString();
      await new PostgresLaunchCohortControl(database, { operatorId: randomUUID() }).apply({
        ...audience,
        requestId: policyId,
        expectedVersion: 0,
        mode: 'cohort',
        expiresAt,
        reviewDigest: 'b'.repeat(64),
        members: [{ userId, productEpoch: 0 }],
      });
      await new PostgresFreeTestCreditModeControl(database, randomUUID()).apply({
        ...audience,
        requestId: randomUUID(),
        expectedVersion: 0,
        enabled: true,
        cohortPolicyId: policyId,
        expiresAt,
      });
      const base = referenceFixtureConfig(),
        config = {
          ...base,
          environment: 'staging' as const,
          telegram: { ...base.telegram, accountMenuEnabled: true, freeTestTopupsEnabled: true },
          redis: { ...base.redis, queuePrefix: 'account-probe-' + randomUUID() },
        };
      const client = new TelegramBotApiMenuClient(`12345:${'a'.repeat(24)}`, (input, init) => {
        if (input.endsWith('/answerCallbackQuery'))
          return Promise.resolve(new Response('{"ok":true,"result":true}'));
        if (typeof init?.body !== 'string') throw new Error('Missing synthetic request body');
        menus.push(JSON.parse(init.body) as Menu);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: serial++, chat: { id: sender, type: 'private' } },
            }),
          ),
        );
      });
      runtime = new TelegramAccountRuntime(
        config,
        database,
        database,
        redis,
        '12345',
        Buffer.alloc(32, 43),
        client,
      );
      await runtime.onModuleInit();
    });
    afterAll(async () => {
      await redis?.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    it('opens Settings and refills repeatedly with no invoices and no duplicate credit for old buttons', async () => {
      expect(await runtime.handle(incoming('/settings'))).toBe('notice');
      expect(latest().text).toContain('Balance: 0 credits');
      await runtime.handle(callback(button('Your credits')));
      expect(latest().text).toContain('for free, as often as you need');
      const old = button('Add 100 free credits');
      await runtime.handle(callback(old));
      expect(latest().text).toContain('Balance: 100 credits');
      await runtime.handle(callback(old));
      expect(latest().text).toContain('Balance: 100 credits');
      await runtime.handle(callback(button('Add 100 free credits')));
      expect(latest().text).toContain('Balance: 200 credits');
      expect(JSON.stringify(menus)).not.toContain('sendInvoice');
      expect(await database.selectFrom('billing.payment_records').select('id').execute()).toEqual(
        [],
      );
    });
    it('rejects another user and a malformed callback before sending account details', async () => {
      const count = menus.length;
      await expect(
        runtime.handle(callback(button('Add 100 free credits'), sender + 1)),
      ).rejects.toMatchObject({ status: 401 });
      await expect(runtime.handle(callback('m9a:malformed'))).rejects.toMatchObject({
        status: 401,
      });
      expect(menus).toHaveLength(count);
    });
  },
);
