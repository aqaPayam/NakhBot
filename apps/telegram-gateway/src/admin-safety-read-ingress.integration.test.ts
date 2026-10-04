import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenSupportThreadHandler, SupportOpaqueReferences } from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  PostgresSupportStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  TelegramAdminTextDelivery,
  TelegramAdminSafetyQueueState,
  type TelegramSafetyReadDraft,
} from '@nakh/telegram';
import {
  createReportUser,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('Telegram admin read composition to PostgreSQL', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 10,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it.each(['prepared', 'selected', 'queue'] as const)(
    'converges %s menus and confirmed callbacks to one audited content delivery, then denies revoked permission',
    async (entry) => {
      const userId = await createReportUser(database),
        adminId = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: adminId,
          role_code: 'support',
          assigned_by_admin_id: adminId,
          revoked_by_admin_id: null,
          revoked_at: null,
        })
        .execute();
      const fixture = await confirmationFixture(database, adminId);
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('telegram_user_id')
        .where('id', '=', adminId)
        .executeTakeFirstOrThrow();
      const now = new Date();
      const opened = await new OpenSupportThreadHandler(
        new PostgresSupportStore(database),
        new SupportOpaqueReferences(fixture.tokens, fixture.key),
        { uuid: randomUUID },
      ).execute({
        actor: { kind: 'user', userId },
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        commandType: 'support.open-thread',
        schemaVersion: 1,
        occurredAt: now.toISOString(),
        locale: 'en',
        data: { text: 'restricted support conversation' },
      });
      const action = await fixture.issue({
        commandCode: 'support.reveal-thread',
        requiredPermission: 'review_support',
        targetType: 'support_thread',
        targetId: opened.supportThreadId,
        expectedTargetVersion: 1,
      });
      const draft: TelegramSafetyReadDraft = {
        kind: 'support',
        command: {
          actor: fixture.actor,
          commandId: randomUUID(),
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          commandType: 'support.reveal-thread',
          schemaVersion: 1,
          occurredAt: now.toISOString(),
          locale: 'en',
          data: {
            adminActionToken: action,
            expectedTargetVersion: 1,
            reason: 'review selected support request',
          },
        },
      };
      const sent: string[] = [];
      const fetcher = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockImplementation((_endpoint, init) => {
          sent.push(init!.body as string);
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })),
          );
        });
      const ingress = createTelegramAdminSafetyReadIngress({
        botId: '123',
        database,
        tokens: fixture.tokens,
        adminKey: fixture.key,
        uiEncryptionKey: new Uint8Array(32).fill(1),
        uiReferenceKey: new Uint8Array(32).fill(2),
        sessions: {
          current: () =>
            Promise.resolve({
              actor: fixture.actor,
              telegramUserId: admin.telegram_user_id,
              locale: 'en',
              expiresAt: new Date(now.getTime() + 300000),
              mfaExpiresAt: new Date(now.getTime() + 300000),
            }),
        },
        renderer: { render: (_locale, intent) => intent.key },
        delivery: new TelegramAdminTextDelivery('123:synthetic-token', fetcher),
      });
      const queueActionToken = await fixture.issue({
        commandCode: 'support.thread-metadata',
        requiredPermission: 'review_support',
        targetType: 'support_queue',
        targetId: null,
        expectedTargetVersion: null,
      });
      const selected = {
        kind: 'support' as const,
        queueActionToken,
        targetId: opened.supportThreadId,
        expectedVersion: 1,
        reason: draft.command.data.reason,
        operationId: 'selected-operation',
        occurredAt: now.toISOString(),
      };
      const prepare = async (): Promise<string> => {
        if (entry === 'prepared')
          return ingress.prepare(admin.telegram_user_id, draft, 'operation');
        if (entry === 'selected') return ingress.select(admin.telegram_user_id, selected);
        const state = new TelegramAdminSafetyQueueState(
          fixture.tokens,
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(2),
        );
        const from = { id: Number(admin.telegram_user_id), is_bot: false },
          chat = { id: Number(admin.telegram_user_id), type: 'private' };
        let updateId = 100;
        const date = Math.floor(now.getTime() / 1000);
        await ingress.handle({
          update_id: updateId++,
          message: { from, chat, date, text: '/admin_support' },
        });
        const count = await database
          .selectFrom('support.support_threads')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .where('status', '=', 'open')
          .executeTakeFirstOrThrow();
        let choice: string | undefined;
        for (let page = 0; page < Math.ceil(Number(count.count) / 10) + 1; page++) {
          const menu = JSON.parse(sent.at(-1)!) as {
            reply_markup: { inline_keyboard: { callback_data: string }[][] };
          };
          const buttons = menu.reply_markup.inline_keyboard.flat();
          for (const button of buttons.filter((button) =>
            button.callback_data.startsWith('m7q:'),
          )) {
            if (
              (await state.choice(fixture.actor, button.callback_data.slice(4)))?.targetId ===
              opened.supportThreadId
            )
              choice = button.callback_data;
          }
          if (choice !== undefined) break;
          const next = buttons.find((button) => button.callback_data.startsWith('m7p:'));
          if (next === undefined) break;
          await ingress.handle({
            update_id: updateId++,
            callback_query: { from, data: next.callback_data, message: { chat } },
          });
        }
        expect(choice).toBeDefined();
        await ingress.handle({
          update_id: updateId++,
          callback_query: { from, data: choice!, message: { chat } },
        });
        const promptId = sent.length;
        expect(sent.at(-1)).toContain('"force_reply":true');
        const reasonUpdate = {
          update_id: updateId,
          message: {
            from,
            chat,
            date,
            text: draft.command.data.reason,
            reply_to_message: { message_id: promptId, from: { id: 123, is_bot: true } },
          },
        };
        await expect(
          ingress.handle({ ...reasonUpdate, message: { ...reasonUpdate.message, text: '   ' } }),
        ).resolves.toBe('notice');
        expect(sent.at(-1)).toContain('error.admin.reason_invalid');
        expect(
          sent.filter((body) => body.includes('restricted support conversation')),
        ).toHaveLength(0);
        await ingress.handle({ ...reasonUpdate, update_id: updateId + 1 });
        const confirmation = JSON.parse(sent.at(-1)!) as {
          reply_markup: { inline_keyboard: { callback_data: string }[][] };
        };
        return confirmation.reply_markup.inline_keyboard[0]![0]!.callback_data.slice(4);
      };
      const refs =
        entry === 'queue'
          ? [await prepare()]
          : await Promise.all(Array.from({ length: 5 }, () => prepare()));
      expect(new Set(refs).size).toBe(1);
      expect(sent.join('')).not.toContain('restricted support conversation');
      const update = {
        update_id: 5,
        callback_query: {
          data: `m7s:${refs[0]!}`,
          from: { id: Number(admin.telegram_user_id), is_bot: false },
          message: { chat: { type: 'private', id: Number(admin.telegram_user_id) } },
        },
      };
      await Promise.all(Array.from({ length: 5 }, () => ingress.handle(update)));
      expect(sent.filter((body) => body.includes('restricted support conversation'))).toHaveLength(
        1,
      );
      const audits = await database
        .selectFrom('administration.safety_access_audits')
        .select(['id', 'command_id'])
        .where('support_thread_id', '=', opened.supportThreadId)
        .execute();
      expect(audits).toHaveLength(1);
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .select('result')
        .where('command_id', '=', audits[0]!.command_id)
        .execute();
      expect(logs).toEqual([{ result: 'succeeded' }]);
      await database
        .updateTable('administration.admin_user_roles')
        .set({ revoked_by_admin_id: adminId, revoked_at: new Date() })
        .where('admin_user_id', '=', adminId)
        .where('revoked_at', 'is', null)
        .execute();
      if (entry === 'queue') {
        const denied = {
          update_id: 1000,
          message: {
            date: Math.floor(now.getTime() / 1000),
            text: '/admin_support',
            from: { id: Number(admin.telegram_user_id), is_bot: false },
            chat: { id: Number(admin.telegram_user_id), type: 'private' },
          },
        };
        await expect(ingress.handle(denied)).resolves.toBe('notice');
        expect(sent.at(-1)).toContain('error.m7.unavailable');
        const delivered = sent.length;
        await expect(ingress.handle(denied)).resolves.toBe('notice');
        expect(sent).toHaveLength(delivered);
      } else await expect(prepare()).rejects.toMatchObject({ code: 'forbidden' });
    },
  );
});
