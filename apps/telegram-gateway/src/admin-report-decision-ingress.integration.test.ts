import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AesGcmReviewNoteProtector } from '@nakh/application';
import type { ReviewAssignmentDraft } from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresPrepareSelectedReportReviewHandler,
  PostgresConfirmedReviewAssignments,
  PostgresConfirmedAccountActions,
  PostgresPrepareReportAccountActionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramAdminTextDelivery, TelegramAdminReportQueueState } from '@nakh/telegram';
import {
  createReportFixtureAdmin,
  createRetainedPhotoReview,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
type Menu = { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
describe.skipIf(url === undefined)('actual assigned report decision ingress', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_decision_ui');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 20,
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
  async function operator(): Promise<
    Awaited<ReturnType<typeof confirmationFixture>> & { adminId: string; telegramUserId: string }
  > {
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'moderator',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const admin = await database
      .selectFrom('administration.admin_users')
      .select('telegram_user_id')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    return {
      ...(await confirmationFixture(database, adminId)),
      adminId,
      telegramUserId: admin.telegram_user_id,
    };
  }
  it.each(['dismissed', 'actioned', 'cancel', 'revoked', 'reassigned'] as const)(
    'records one %s outcome under UI confirmation retries without additional evidence/account effects',
    async (mode) => {
      const f = await operator(),
        fixture = await createRetainedPhotoReview(database),
        now = new Date(),
        sent: string[] = [];
      const root = await new PostgresGetAdminReportQueueActionsHandler(
        database,
        f.tokens,
        f.key,
      ).execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
      const selector = new PostgresPrepareSelectedReportReviewHandler(database, f.tokens, f.key);
      const target = await selector.execute(
        {
          actor: f.actor,
          requestId: randomUUID(),
          adminActionToken: root.metadataActionToken,
          reportId: fixture.reportId,
          expectedReportVersion: 2,
          action: 'assign',
        },
        f.actor,
      );
      const id = randomUUID();
      const draft: ReviewAssignmentDraft = {
        actor: f.actor,
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        schemaVersion: 1,
        occurredAt: now.toISOString(),
        locale: 'en',
        commandType: 'moderation.assign-review',
        data: {
          adminActionToken: target.adminActionToken,
          expectedTargetVersion: target.reviewVersion,
          assigneeAdminId: target.assigneeAdminId,
          reason: 'Assigned before decision',
        },
      };
      const assignments = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key);
      const confirmed = await assignments.prepare(draft, f.actor);
      expect(
        await assignments.execute(
          { ...draft, data: { ...draft.data, confirmationToken: confirmed } },
          f.actor,
        ),
      ).toMatchObject({ result: 'succeeded' });
      if (mode === 'actioned') {
        const access = await new PostgresPrepareReportAccountActionHandler(
          database,
          f.tokens,
          f.key,
        ).execute(
          {
            actor: f.actor,
            requestId: randomUUID(),
            adminActionToken: root.metadataActionToken,
            reviewId: fixture.reviewId,
            expectedReviewVersion: 2,
            action: 'restrict_user',
          },
          f.actor,
        );
        const actionId = randomUUID();
        const action: Parameters<PostgresConfirmedAccountActions['prepare']>[0] = {
          ...draft,
          commandId: actionId,
          requestId: actionId,
          idempotencyKey: actionId,
          commandType: 'moderation.apply-account-action',
          data: {
            adminActionToken: access.adminActionToken,
            expectedTargetVersion: access.accountVersion,
            action: 'restrict_user',
            reason: 'Separate prior account action',
          },
        };
        const commands = new PostgresConfirmedAccountActions(database, f.tokens, f.key);
        const confirmationToken = await commands.prepare(action, f.actor);
        expect(
          await commands.execute(
            { ...action, data: { ...action.data, confirmationToken } },
            f.actor,
          ),
        ).toMatchObject({ result: 'succeeded' });
      }
      const baselineLogs = mode === 'actioned' ? 2 : 1;
      const baselineNotifications = await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', fixture.target)
        .execute();
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
        reviewNotes: new AesGcmReviewNoteProtector('ui-review-notes', 1, Buffer.alloc(32, 3)),
        uiEncryptionKey: new Uint8Array(32).fill(1),
        uiReferenceKey: new Uint8Array(32).fill(2),
        sessions: {
          current: () =>
            Promise.resolve({
              actor: f.actor,
              telegramUserId: f.telegramUserId,
              locale: 'en',
              expiresAt: new Date(now.getTime() + 300000),
              mfaExpiresAt: new Date(now.getTime() + 300000),
            }),
        },
        renderer: { render: (_locale, intent) => intent.key },
        delivery: new TelegramAdminTextDelivery('123:synthetic-token', fetcher),
      });
      const state = new TelegramAdminReportQueueState(
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      const from = { id: Number(f.telegramUserId), is_bot: false },
        chat = { id: Number(f.telegramUserId), type: 'private' };
      let updateId = 100;
      const callback = async (data: string): Promise<'notice' | 'unhandled'> =>
        ingress.handle({
          update_id: updateId++,
          callback_query: { from, data, message: { chat } },
        });
      await ingress.handle({
        update_id: updateId++,
        message: { from, chat, date: Math.floor(now.getTime() / 1000), text: '/admin_reports' },
      });
      const count = await database
        .selectFrom('moderation.reports')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('status', '=', 'pending_review')
        .executeTakeFirstOrThrow();
      let choice: string | undefined;
      for (let page = 0; page < Math.ceil(Number(count.count) / 10) + 1; page++) {
        const rows = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard;
        for (const row of rows) {
          const data = row[0]!.callback_data;
          if (
            data.startsWith('m7T:') &&
            (await state.choice(f.actor, data.slice(4)))?.targetId === fixture.reportId
          ) {
            choice = data;
            break;
          }
        }
        if (choice !== undefined) break;
        const next = rows.flat().find((button) => button.callback_data.startsWith('m7O:'));
        expect(next).toBeDefined();
        await callback(next!.callback_data);
      }
      expect(choice).toBeDefined();
      const before = await database
        .selectFrom('moderation.moderation_reviews')
        .selectAll()
        .where('id', '=', fixture.reviewId)
        .executeTakeFirstOrThrow();
      await callback(choice!);
      const options = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
        .flat()
        .map((button) => button.callback_data);
      expect(options.some((data) => data.startsWith('m7D:'))).toBe(true);
      expect(options.some((data) => data.startsWith('m7A:'))).toBe(mode === 'actioned');
      if (mode !== 'actioned') {
        await callback(choice!.replace('m7T:', 'm7A:'));
        expect(sent.at(-1)).toContain('error.m7.unavailable');
      }
      await callback(choice!.replace('m7T:', mode === 'actioned' ? 'm7A:' : 'm7D:'));
      expect(sent.at(-1)).toContain('"force_reply":true');
      const promptId = sent.length;
      const reason = {
        update_id: updateId++,
        message: {
          from,
          chat,
          date: Math.floor(now.getTime() / 1000),
          text: 'Decide this exact review\nPrivate encrypted decision note',
          reply_to_message: { message_id: promptId, from: { id: 123, is_bot: true } },
        },
      };
      await Promise.all(Array.from({ length: 10 }, () => ingress.handle(reason)));
      const confirmation = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
        .callback_data;
      expect(confirmation).toMatch(/^m7G:[A-Za-z0-9_-]{22}$/u);
      expect(sent.at(-1)).toContain('admin.report.decision_effect');
      expect(
        await database
          .selectFrom('moderation.moderation_reviews')
          .selectAll()
          .where('id', '=', fixture.reviewId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', f.adminId)
          .execute(),
      ).toHaveLength(baselineLogs);
      await ingress.handle({
        ...reason,
        message: { ...reason.message, text: 'Changed decision reason' },
      });
      expect(sent.at(-1)).toContain('error.m7.stale_action');
      if (mode === 'cancel') await callback(confirmation.replace('m7G:', 'm7Z:'));
      if (mode === 'revoked')
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .where('revoked_at', 'is', null)
          .execute();
      if (mode === 'reassigned') {
        const other = await operator();
        const root = await new PostgresGetAdminReportQueueActionsHandler(
          database,
          other.tokens,
          other.key,
        ).execute({ actor: other.actor, requestId: randomUUID() }, other.actor);
        const target = await new PostgresPrepareSelectedReportReviewHandler(
          database,
          other.tokens,
          other.key,
        ).execute(
          {
            actor: other.actor,
            requestId: randomUUID(),
            adminActionToken: root.metadataActionToken,
            reportId: fixture.reportId,
            expectedReportVersion: 2,
            action: 'assign',
          },
          other.actor,
        );
        const id = randomUUID();
        const draft: ReviewAssignmentDraft = {
          actor: other.actor,
          commandId: id,
          requestId: id,
          idempotencyKey: id,
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          commandType: 'moderation.assign-review',
          data: {
            adminActionToken: target.adminActionToken,
            expectedTargetVersion: target.reviewVersion,
            assigneeAdminId: target.assigneeAdminId,
            reason: 'Competing own assignment',
          },
        };
        const native = new PostgresConfirmedReviewAssignments(database, other.tokens, other.key);
        const confirmationToken = await native.prepare(draft, other.actor);
        expect(
          await native.execute(
            { ...draft, data: { ...draft.data, confirmationToken } },
            other.actor,
          ),
        ).toMatchObject({ result: 'succeeded' });
      }
      const beforeConfirm = await database
        .selectFrom('moderation.moderation_reviews')
        .selectAll()
        .where('id', '=', fixture.reviewId)
        .executeTakeFirstOrThrow();
      const update = {
        update_id: updateId++,
        callback_query: { from, data: confirmation, message: { chat } },
      };
      if (mode === 'cancel') {
        const attempts = await Promise.allSettled(
          Array.from({ length: 10 }, () => ingress.handle(update)),
        );
        expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
        for (const attempt of attempts)
          if (attempt.status === 'rejected')
            expect(attempt.reason as unknown).toMatchObject({
              code: 'internal_error',
              status: 500,
            });
        const acknowledged = sent.length;
        await Promise.all(Array.from({ length: 10 }, () => ingress.handle(update)));
        expect(sent).toHaveLength(acknowledged);
      } else await Promise.all(Array.from({ length: 10 }, () => ingress.handle(update)));
      const review = await database
        .selectFrom('moderation.moderation_reviews')
        .selectAll()
        .where('id', '=', fixture.reviewId)
        .executeTakeFirstOrThrow();
      if (mode === 'dismissed' || mode === 'actioned') {
        expect(review).toMatchObject({
          status: mode,
          assigned_admin_id: f.adminId,
          version: 3,
          decision_note_key_id: 'ui-review-notes',
        });
        expect(review.decision_note_ciphertext).not.toBeNull();
        expect(review.decision_note_ciphertext!.toString('utf8')).not.toContain(
          'Private encrypted decision note',
        );
      } else expect(review).toEqual(beforeConfirm);
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'command_code', 'metadata'])
        .where('admin_user_id', '=', f.adminId)
        .where('command_code', '=', 'moderation.decide-review')
        .execute();
      expect(logs).toHaveLength(mode === 'cancel' ? 0 : 1);
      if (logs.length)
        expect(logs[0]).toMatchObject({
          command_code: 'moderation.decide-review',
          result: mode === 'revoked' || mode === 'reassigned' ? 'rejected' : 'succeeded',
        });
      expect(JSON.stringify(logs)).not.toContain(reason.message.text);
      expect(JSON.stringify(logs)).not.toContain('Private encrypted decision note');
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select('id')
          .where('report_id', '=', fixture.reportId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', fixture.target)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: mode === 'actioned' ? 'restricted' : 'active' });
      expect(
        await database
          .selectFrom('notification.notifications')
          .select('id')
          .where('user_id', '=', fixture.target)
          .execute(),
      ).toEqual(baselineNotifications);
      for (const secret of [
        fixture.reporter,
        fixture.target,
        fixture.reportId,
        fixture.reviewId,
        f.adminId,
      ])
        expect(sent.join('')).not.toContain(secret);
      for (const body of sent)
        expect(JSON.parse(body)).toMatchObject({
          protect_content: true,
          link_preview_options: { is_disabled: true },
        });
    },
  );
});
