import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  runMigrations,
  PostgresAppealStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramAdminTextDelivery, TelegramAdminSafetyQueueState } from '@nakh/telegram';
import {
  createReportUser,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
async function ban(database: NakhDatabase, userId: string): Promise<string> {
  const id = randomUUID();
  await database.transaction().execute(async (tx) => {
    const account = await tx
      .selectFrom('identity.accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = new Date(Math.max(Date.now(), account.state_changed_at.getTime() + 1));
    await tx
      .updateTable('identity.accounts')
      .set({
        state: 'banned',
        state_reason: 'test_ban',
        state_changed_at: now,
        version: account.version + 1,
      })
      .where('user_id', '=', userId)
      .execute();
    await tx
      .insertInto('identity.account_state_history')
      .values({
        id,
        user_id: userId,
        previous_state: account.state,
        next_state: 'banned',
        reason_code: 'test_ban',
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        changed_at: now,
      })
      .execute();
  });
  return id;
}
type Menu = { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
describe.skipIf(url === undefined)('separate accepted-appeal unban UI to PostgreSQL', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    // Review-only test roles must not alter the shared database's immutable seed catalog.
    isolated = await createIsolatedTestDatabase(url!, 'nakh_appeal_unban_ui');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 10,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  it.each([
    'restored',
    'cancel',
    'revoked',
    'account_version',
    'reban',
    'review_only',
    'rejected',
    'pending',
  ] as const)(
    'restores %s only through separately authorized confirmed exact-ban unban',
    async (mode) => {
      const userId = await createReportUser(database),
        adminId = await createReportFixtureAdmin(database);
      const reviewRole = 'appeal_ui_review_' + randomUUID().replaceAll('-', '');
      await database
        .insertInto('administration.admin_roles')
        .values({ code: reviewRole, description: 'Test review-only operator' })
        .execute();
      await database
        .insertInto('administration.admin_role_permissions')
        .values({ role_code: reviewRole, permission_code: 'review_appeals' })
        .execute();
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: adminId,
          role_code: mode === 'review_only' ? reviewRole : 'moderator',
          assigned_by_admin_id: adminId,
          revoked_by_admin_id: null,
          revoked_at: null,
        })
        .execute();
      const f = await confirmationFixture(database, adminId);
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('telegram_user_id')
        .where('id', '=', adminId)
        .executeTakeFirstOrThrow();
      const historyId = await ban(database, userId),
        commandId = randomUUID(),
        appealId = randomUUID();
      await new PostgresAppealStore(database).submit({
        userId,
        banHistoryId: historyId,
        appealId,
        commandId,
        eventId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: commandId,
        requestDigest: createHash('sha256').update(commandId).digest('hex'),
        normalizedText: 'Restricted appeal explanation',
      });
      const now = new Date(),
        sent: string[] = [];
      const fetcher = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockImplementation((_url, init) => {
          sent.push(init!.body as string);
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })),
          );
        });
      const ingress = createTelegramAdminSafetyReadIngress({
        database,
        botId: '123',
        tokens: f.tokens,
        adminKey: f.key,
        uiEncryptionKey: new Uint8Array(32).fill(1),
        uiReferenceKey: new Uint8Array(32).fill(2),
        sessions: {
          current: () =>
            Promise.resolve({
              actor: f.actor,
              telegramUserId: admin.telegram_user_id,
              locale: 'en',
              expiresAt: new Date(now.getTime() + 300000),
              mfaExpiresAt: new Date(now.getTime() + 300000),
            }),
        },
        renderer: { render: (_locale, intent) => intent.key },
        delivery: new TelegramAdminTextDelivery('123:synthetic-token', fetcher),
      });
      const state = new TelegramAdminSafetyQueueState(
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      const from = { id: Number(admin.telegram_user_id), is_bot: false },
        chat = { id: Number(admin.telegram_user_id), type: 'private' };
      let updateId = 100;
      const callback = async (data: string): Promise<'notice' | 'unhandled'> =>
        ingress.handle({
          update_id: updateId++,
          callback_query: { from, data, message: { chat } },
        });
      const selectQueue = async (
        status: 'submitted' | 'accepted' | 'rejected',
      ): Promise<string> => {
        await ingress.handle({
          update_id: updateId++,
          message: {
            from,
            chat,
            date: Math.floor(now.getTime() / 1000),
            text: `/admin_appeals ${status}`,
          },
        });
        const count = await database
          .selectFrom('moderation.user_appeals')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .where('status', '=', status)
          .executeTakeFirstOrThrow();
        let choice: string | undefined;
        for (let page = 0; page < Math.ceil(Number(count.count) / 10) + 1; page++) {
          const rows = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard;
          for (const row of rows) {
            const data = row[0]!.callback_data;
            if (
              data.startsWith('m7q:') &&
              (await state.choice(f.actor, data.slice(4)))?.targetId === appealId
            ) {
              choice = data;
              break;
            }
          }
          if (choice !== undefined) break;
          const next = rows.flat().find((button) => button.callback_data.startsWith('m7p:'));
          expect(next).toBeDefined();
          await callback(next!.callback_data);
        }
        expect(choice).toBeDefined();
        return choice!;
      };
      let choice = await selectQueue('submitted');
      await callback(choice);
      expect(
        (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
          .flat()
          .map((button) => button.callback_data.slice(0, 4)),
      ).toEqual(['m7v:', 'm7a:', 'm7b:']);
      if (mode === 'pending') {
        await callback(choice.replace('m7q:', 'm7u:'));
        expect(sent.at(-1)).toContain('error.');
        expect(sent.at(-1)).not.toContain('force_reply');
        expect(
          await database
            .selectFrom('moderation.appeal_unbans')
            .select('appeal_id')
            .where('appeal_id', '=', appealId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('administration.admin_action_logs')
            .select('id')
            .where('target_id', '=', appealId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('identity.accounts')
            .select('state')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'banned' });
        return;
      }
      await callback(choice.replace('m7q:', mode === 'rejected' ? 'm7b:' : 'm7a:'));
      expect(sent.at(-1)).toContain('"force_reply":true');
      const promptId = sent.length;
      const reasonUpdate = {
        update_id: updateId++,
        message: {
          from,
          chat,
          date: Math.floor(now.getTime() / 1000),
          text: 'Review exact ban appeal\nPrivate appeal review note',
          reply_to_message: { message_id: promptId, from: { id: 123, is_bot: true } },
        },
      };
      await Promise.all(Array.from({ length: 5 }, () => ingress.handle(reasonUpdate)));
      const confirmation = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
        .callback_data;
      expect(confirmation).toMatch(/^m7d:[A-Za-z0-9_-]{22}$/u);
      expect(sent.at(-1)).toContain('admin.appeal.ban_remains');
      await Promise.all(Array.from({ length: 5 }, () => callback(confirmation)));
      expect(
        await database
          .selectFrom('identity.accounts')
          .select(['state', 'version'])
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'banned', version: 2 });
      expect(
        await database
          .selectFrom('moderation.user_appeals')
          .select(['status', 'version'])
          .where('id', '=', appealId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: mode === 'rejected' ? 'rejected' : 'accepted', version: 2 });
      choice = await selectQueue(mode === 'rejected' ? 'rejected' : 'accepted');
      await callback(choice);
      const buttons = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard.flat();
      if (mode === 'review_only' || mode === 'rejected') {
        expect(buttons.map((button) => button.callback_data.slice(0, 4))).toEqual(['m7v:']);
        await callback(choice.replace('m7q:', 'm7u:'));
        expect(sent.at(-1)).toContain('error.');
        expect(sent.at(-1)).not.toContain('force_reply');
        expect(
          await database
            .selectFrom('administration.admin_action_logs')
            .select('id')
            .where('target_id', '=', appealId)
            .where('command_code', '=', 'moderation.unban-appeal')
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('identity.accounts')
            .select('state')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'banned' });
        return;
      }
      expect(buttons.map((button) => button.callback_data.slice(0, 4))).toEqual(['m7v:', 'm7u:']);
      await callback(choice.replace('m7q:', 'm7u:'));
      expect(sent.at(-1)).toContain('"force_reply":true');
      const unbanPrompt = sent.length;
      const unbanReason = {
        update_id: updateId++,
        message: {
          from,
          chat,
          date: Math.floor(now.getTime() / 1000),
          text: 'Restore access after accepted appeal',
          reply_to_message: { message_id: unbanPrompt, from: { id: 123, is_bot: true } },
        },
      };
      await Promise.all(Array.from({ length: 5 }, () => ingress.handle(unbanReason)));
      const unbanConfirmation = (JSON.parse(sent.at(-1)!) as Menu).reply_markup
        .inline_keyboard[0]![0]!.callback_data;
      expect(unbanConfirmation).toMatch(/^m7h:[A-Za-z0-9_-]{22}$/u);
      expect(sent.at(-1)).toContain('admin.appeal.unban_effect');
      await ingress.handle({
        ...unbanReason,
        message: { ...unbanReason.message, text: 'Changed restoration reason' },
      });
      expect(sent.at(-1)).toContain('error.m7.stale_action');
      if (mode === 'cancel') await callback(unbanConfirmation.replace('m7h:', 'm7n:'));
      if (mode === 'revoked') {
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
          .where('admin_user_id', '=', adminId)
          .where('revoked_at', 'is', null)
          .execute();
        await database
          .insertInto('administration.admin_user_roles')
          .values({
            admin_user_id: adminId,
            role_code: reviewRole,
            assigned_by_admin_id: adminId,
            revoked_by_admin_id: null,
            revoked_at: null,
          })
          .execute();
      }
      if (mode === 'account_version')
        await database
          .updateTable('identity.accounts')
          .set({ version: 3 })
          .where('user_id', '=', userId)
          .execute();
      if (mode === 'reban') {
        // Simulate an independent restore followed by a new ban; history never permits
        // banned -> banned, and the pending review must remain bound to the original event.
        await database.transaction().execute(async (tx) => {
          const account = await tx
            .selectFrom('identity.accounts')
            .selectAll()
            .where('user_id', '=', userId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const changedAt = new Date(Math.max(Date.now(), account.state_changed_at.getTime() + 1));
          await tx
            .updateTable('identity.accounts')
            .set({
              state: 'active',
              state_reason: null,
              state_changed_at: changedAt,
              version: account.version + 1,
            })
            .where('user_id', '=', userId)
            .execute();
          await tx
            .insertInto('identity.account_state_history')
            .values({
              id: randomUUID(),
              user_id: userId,
              previous_state: 'banned',
              next_state: 'active',
              reason_code: 'test_restore',
              actor_type: 'system',
              actor_user_id: null,
              actor_admin_id: null,
              changed_at: changedAt,
            })
            .execute();
        });
        await ban(database, userId);
      }
      const accountBefore = await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      const update = {
        update_id: updateId++,
        callback_query: { from, data: unbanConfirmation, message: { chat } },
      };
      if (mode === 'cancel') {
        const attempts = await Promise.allSettled(
          Array.from({ length: 5 }, () => ingress.handle(update)),
        );
        expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
        for (const attempt of attempts)
          if (attempt.status === 'rejected')
            expect(attempt.reason as unknown).toMatchObject({
              code: 'internal_error',
              status: 500,
            });
        const acknowledged = sent.length;
        await Promise.all(Array.from({ length: 5 }, () => ingress.handle(update)));
        expect(sent).toHaveLength(acknowledged);
      } else await Promise.all(Array.from({ length: 5 }, () => ingress.handle(update)));
      const effect = mode === 'restored';
      const account = await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (effect) expect(account).toMatchObject({ state: 'active', version: 3 });
      else expect(account).toEqual(accountBefore);
      expect(
        await database
          .selectFrom('moderation.user_appeals')
          .select(['status', 'version', 'ban_state_history_id'])
          .where('id', '=', appealId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'accepted', version: 2, ban_state_history_id: historyId });
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .select(['id', 'command_id', 'result', 'metadata'])
        .where('target_id', '=', appealId)
        .where('command_code', '=', 'moderation.unban-appeal')
        .execute();
      expect(logs).toHaveLength(mode === 'cancel' ? 0 : 1);
      if (logs.length) expect(logs[0]!.result).toBe(effect ? 'succeeded' : 'rejected');
      expect(JSON.stringify(logs)).not.toContain('Restore access after accepted appeal');
      const proof = await database
        .selectFrom('moderation.appeal_unbans')
        .selectAll()
        .where('appeal_id', '=', appealId)
        .execute();
      expect(proof).toHaveLength(effect ? 1 : 0);
      const notices = await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', userId)
        .execute();
      expect(notices).toHaveLength(effect ? 1 : 0);
      if (effect) {
        expect(proof[0]!.admin_action_log_id).toBe(logs[0]!.id);
        expect(
          await database
            .selectFrom('identity.account_state_history')
            .select(['previous_state', 'next_state'])
            .where('id', '=', proof[0]!.unban_history_id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ previous_state: 'banned', next_state: 'active' });
        expect(
          await database
            .selectFrom('moderation.moderation_actions')
            .select(['action_type', 'target_user_id'])
            .where('id', '=', proof[0]!.action_id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ action_type: 'unban_user', target_user_id: userId });
        expect(
          await database
            .selectFrom('notification.notification_deliveries')
            .select('id')
            .where('notification_id', '=', notices[0]!.id)
            .execute(),
        ).toHaveLength(1);
        const events = await database
          .selectFrom('platform.outbox_events')
          .select(['event_type', 'payload'])
          .where('causation_id', '=', logs[0]!.command_id)
          .execute();
        expect(events.map((event) => event.event_type).sort()).toEqual([
          'identity.account-state-changed.v1',
          'moderation.action-recorded.v1',
          'notification.delivery-requested.v1',
        ]);
        expect(JSON.stringify(events)).not.toContain('Restore access after accepted appeal');
        expect(JSON.stringify(events)).not.toContain('Restricted appeal explanation');
      }
      expect(sent.join('')).not.toContain('Restricted appeal explanation');
      expect(
        await database
          .selectFrom('administration.safety_access_audits')
          .select('id')
          .where('user_appeal_id', '=', appealId)
          .execute(),
      ).toHaveLength(0);
    },
  );
});
