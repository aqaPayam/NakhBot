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
import { TelegramAdminTextDelivery, type TelegramSafetyReadDraft } from '@nakh/telegram';
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
  it.each(['prepared', 'selected'] as const)(
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
          return Promise.resolve(new Response('{"ok":true,"result":{"message_id":1}}'));
        });
      const ingress = createTelegramAdminSafetyReadIngress({
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
      const prepare = (): Promise<string> =>
        entry === 'prepared'
          ? ingress.prepare(admin.telegram_user_id, draft, 'operation')
          : ingress.select(admin.telegram_user_id, selected);
      const refs = await Promise.all(Array.from({ length: 5 }, () => prepare()));
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
      await expect(prepare()).rejects.toMatchObject({ code: 'forbidden' });
    },
  );
});
