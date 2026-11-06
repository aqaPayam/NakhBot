import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresLocalizationStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import { CatalogRenderer } from '@nakh/localization';
import { TelegramAdminTextDelivery, TelegramBotApiMenuClient } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTotpAdminSessionFixture } from '../../../packages/persistence-postgres/src/testing/totp-admin-session-fixture.js';
import {
  createProtectedChangeProfile,
  protectedChangeOwnerStore,
  protectedChangeWrite,
} from '../../../packages/persistence-postgres/src/testing/protected-profile-change-fixture.js';
import { TelegramAdminProfileReviewRuntime } from './admin-profile-review-runtime.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
type Message = {
  recipient: string;
  text: string;
  private: boolean;
  previewDisabled: boolean;
  parseMode: unknown;
  buttons: Array<{ text: string; callback_data: string }>;
};
describe.skipIf(url === undefined || redisUrl === undefined)(
  'native staff profile correction bot journey',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      database: NakhDatabase,
      redis: ReturnType<typeof createRedisConnection>;
    let f: Awaited<ReturnType<typeof createTotpAdminSessionFixture>>,
      runtime: TelegramAdminProfileReviewRuntime;
    let requestId: string,
      profileId: string,
      prefix: string,
      sender: number,
      privateAttempts: number,
      failPrivate: boolean;
    const fixtures: Array<Awaited<ReturnType<typeof createTotpAdminSessionFixture>>> = [],
      messages: Message[] = [];
    const reason = 'Private correction explanation https://example.invalid/never-preview';
    let serial = 93000;
    const incoming = (): unknown => ({
      update_id: serial++,
      message: {
        message_id: serial++,
        date: Math.floor(Date.now() / 1000),
        text: '/admin_changes',
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
    const latest = (): Message => messages.at(-1)!;
    const button = (label: string): string => {
      const b = latest().buttons.find((b) => b.text === label);
      if (!b) throw new Error('Missing synthetic staff button: ' + label);
      return b.callback_data;
    };
    const readButton = async (): Promise<string> => {
      await runtime.handle(incoming());
      const row = await database
        .selectFrom('profile.profile_change_requests')
        .select('submitted_at')
        .where('id', '=', requestId)
        .executeTakeFirstOrThrow();
      await runtime.handle(callback(button('Birth year · ' + row.submitted_at.toISOString())));
      return button('View request');
    };
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'staff_profile_ui');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 20000,
      });
      redis = createRedisConnection(redisUrl!);
    });
    beforeEach(async () => {
      messages.length = 0;
      privateAttempts = 0;
      failPrivate = false;
      f = await createTotpAdminSessionFixture(database);
      fixtures.push(f);
      sender = Number(f.telegramUserId);
      prefix = 'staff-profile-' + randomUUID();
      const target = await createProtectedChangeProfile(database);
      profileId = target.profileId;
      const base = protectedChangeWrite(target.userId),
        write = {
          ...base,
          command: { ...base.command, data: { ...base.command.data, reason } },
          normalized: { ...base.normalized, reason },
        };
      requestId = write.profileChangeRequestId;
      await (
        await protectedChangeOwnerStore(database, target.userId, 0)
      ).requestProtectedChange(write);
      const catalog = await new PostgresLocalizationStore(database).loadActiveCatalog('en'),
        renderer = new CatalogRenderer({ en: catalog.messages }, 'en');
      const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
        if (input.endsWith('/answerCallbackQuery'))
          return new Response('{"ok":true,"result":true}');
        if (typeof init?.body !== 'string') throw new Error('Missing synthetic staff request');
        const body = JSON.parse(init.body) as {
          chat_id: string;
          text: string;
          protect_content?: boolean;
          parse_mode?: unknown;
          link_preview_options?: { is_disabled?: boolean };
          reply_markup?: { inline_keyboard?: Message['buttons'][] };
        };
        if (body.protect_content) {
          privateAttempts++;
          expect(
            await database
              .selectFrom('platform.audit_logs')
              .select('id')
              .where('subject_id', '=', requestId)
              .where('event_type', '=', 'profile.reveal-change-request.v1')
              .execute(),
          ).toHaveLength(privateAttempts);
          if (failPrivate) {
            failPrivate = false;
            throw new Error('Ambiguous synthetic protected delivery');
          }
        }
        messages.push({
          recipient: body.chat_id,
          text: body.text,
          private: body.protect_content === true,
          previewDisabled: body.link_preview_options?.is_disabled === true,
          parseMode: body.parse_mode,
          buttons: body.reply_markup?.inline_keyboard?.flat() ?? [],
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: serial++,
              from: { id: 12345, is_bot: true },
              chat: { id: Number(body.chat_id), type: 'private' },
            },
          }),
        );
      };
      const token = `12345:${'a'.repeat(24)}`;
      runtime = new TelegramAdminProfileReviewRuntime(
        database,
        redis,
        prefix,
        '12345',
        Buffer.alloc(32, 87),
        new TelegramBotApiMenuClient(token, fetcher),
        new TelegramAdminTextDelivery(token, fetcher),
        { render: (locale, intent) => renderer.render(locale, intent) },
      );
      await runtime.onModuleInit();
    });
    afterAll(async () => {
      fixtures.forEach((f) => f.dispose());
      await redis?.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    it('requires an audited body read and explicit review confirmation before changing a protected field', async () => {
      const read = await readButton();
      expect(messages.every((m) => !m.text.includes(reason))).toBe(true);
      await runtime.handle(callback(read));
      const body = messages.find((m) => m.private)!;
      expect(body.text).toContain(reason);
      expect(body).toMatchObject({ previewDisabled: true, parseMode: undefined });
      await runtime.handle(callback(button('Approve correction')));
      expect(
        (
          await database
            .selectFrom('profile.profiles')
            .select('birth_year')
            .where('id', '=', profileId)
            .executeTakeFirstOrThrow()
        ).birth_year,
      ).toBe(1995);
      const confirm = button('Confirm review');
      await runtime.handle(callback(confirm));
      await runtime.handle(callback(confirm));
      expect(latest().text).toBe('Review saved.');
      expect(privateAttempts).toBe(1);
      expect(
        (
          await database
            .selectFrom('profile.profiles')
            .select('birth_year')
            .where('id', '=', profileId)
            .executeTakeFirstOrThrow()
        ).birth_year,
      ).toBe(1994);
      expect(
        await database
          .selectFrom('profile.profile_change_reviews')
          .select('request_id')
          .where('request_id', '=', requestId)
          .execute(),
      ).toHaveLength(1);
      const values: string[] = [];
      for (const key of await redis.keys(prefix + '*'))
        if ((await redis.type(key)) === 'string') values.push((await redis.get(key)) ?? '');
      expect(values.join('\n')).not.toContain(reason);
      expect(values.join('\n')).not.toContain('requestedValue');
    });
    it('rejects a borrowed button and refuses to upgrade old navigation after a fresh MFA sign-in', async () => {
      const read = await readButton();
      await runtime.handle(callback(read, sender + 1));
      expect(privateAttempts).toBe(0);
      expect(latest().recipient).toBe(String(sender + 1));
      expect(latest().text).not.toContain(reason);
      await f.revoke();
      await f.issueNext();
      await runtime.handle(callback(read));
      expect(privateAttempts).toBe(0);
      expect(latest().text).toContain('unavailable');
      await runtime.handle(callback(await readButton()));
      expect(privateAttempts).toBe(1);
    });
    it('does not resend a private body on ambiguous delivery or webhook replay', async () => {
      const read = await readButton();
      failPrivate = true;
      await expect(runtime.handle(callback(read))).rejects.toMatchObject({ status: 500 });
      await runtime.handle(callback(read));
      expect(privateAttempts).toBe(1);
      expect(latest().text).toContain('already been processed');
      await runtime.handle(callback(await readButton()));
      expect(privateAttempts).toBe(2);
    });
    it('rejects a correction only after a separate confirmation and preserves the protected value', async () => {
      await runtime.handle(callback(await readButton()));
      await runtime.handle(callback(button('Reject correction')));
      const confirm = button('Confirm review');
      await runtime.handle(callback(confirm));
      expect(
        (
          await database
            .selectFrom('profile.profiles')
            .select('birth_year')
            .where('id', '=', profileId)
            .executeTakeFirstOrThrow()
        ).birth_year,
      ).toBe(1995);
      expect(
        (
          await database
            .selectFrom('profile.profile_change_requests')
            .select('status')
            .where('id', '=', requestId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('rejected');
    });
  },
);
