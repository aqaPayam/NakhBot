import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AesGcmReviewNoteProtector } from '@nakh/application';
import type { ReviewAssignmentDraft, ReviewDecisionDraft } from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresPrepareSelectedReportReviewHandler,
  PostgresConfirmedReviewAssignments,
  PostgresConfirmedReviewDecisions,
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
describe.skipIf(url === undefined)(
  'actual report queue and confirmed own-review assignment ingress',
  () => {
    let database: NakhDatabase,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'nakh_report_assignment_ui');
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
    it.each(['assigned', 'cancel', 'revoked', 'reassigned', 'dismissed'] as const)(
      'records one %s outcome under UI confirmation retries without evidence/account effects',
      async (mode) => {
        const f = await operator(),
          fixture = await createRetainedPhotoReview(database),
          now = new Date(),
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
        expect(sent.at(-1)).toContain('"force_reply":true');
        const promptId = sent.length;
        const reason = {
          update_id: updateId++,
          message: {
            from,
            chat,
            date: Math.floor(now.getTime() / 1000),
            text: 'Take responsibility for this exact review',
            reply_to_message: { message_id: promptId, from: { id: 123, is_bot: true } },
          },
        };
        await Promise.all(Array.from({ length: 10 }, () => ingress.handle(reason)));
        const confirmation = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
          .callback_data;
        expect(confirmation).toMatch(/^m7F:[A-Za-z0-9_-]{22}$/u);
        expect(sent.at(-1)).toContain('admin.report.assign_effect');
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
        ).toHaveLength(0);
        await ingress.handle({
          ...reason,
          message: { ...reason.message, text: 'Changed assignment reason' },
        });
        expect(sent.at(-1)).toContain('error.m7.stale_action');
        if (mode === 'cancel') await callback(confirmation.replace('m7F:', 'm7Y:'));
        if (mode === 'revoked')
          await database
            .updateTable('administration.admin_user_roles')
            .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
            .where('admin_user_id', '=', f.adminId)
            .where('revoked_at', 'is', null)
            .execute();
        if (mode === 'reassigned' || mode === 'dismissed') {
          const other = await operator(),
            root = await new PostgresGetAdminReportQueueActionsHandler(
              database,
              other.tokens,
              other.key,
            ).execute({ actor: other.actor, requestId: randomUUID() }, other.actor);
          const selector = new PostgresPrepareSelectedReportReviewHandler(
              database,
              other.tokens,
              other.key,
            ),
            query = {
              actor: other.actor,
              requestId: randomUUID(),
              adminActionToken: root.metadataActionToken,
              reportId: fixture.reportId,
              expectedReportVersion: 2,
              action: 'assign' as const,
            };
          const target = await selector.execute(query, other.actor),
            id = randomUUID();
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
              reason: 'Competing own-review assignment',
            },
          };
          const native = new PostgresConfirmedReviewAssignments(database, other.tokens, other.key),
            token = await native.prepare(draft, other.actor);
          expect(
            await native.execute(
              { ...draft, data: { ...draft.data, confirmationToken: token } },
              other.actor,
            ),
          ).toMatchObject({ result: 'succeeded' });
          if (mode === 'dismissed') {
            const selected = await selector.execute({ ...query, action: 'dismissed' }, other.actor),
              decisionId = randomUUID();
            const decision: ReviewDecisionDraft = {
              ...draft,
              commandId: decisionId,
              requestId: decisionId,
              idempotencyKey: decisionId,
              commandType: 'moderation.decide-review',
              data: {
                adminActionToken: selected.adminActionToken,
                expectedTargetVersion: selected.reviewVersion,
                decision: 'dismissed',
                reason: 'Competing report dismissal',
              },
            };
            const decisions = new PostgresConfirmedReviewDecisions(
                database,
                other.tokens,
                other.key,
                new AesGcmReviewNoteProtector('test-review-note', 1, Buffer.alloc(32, 3)),
              ),
              confirmed = await decisions.prepare(decision, other.actor);
            expect(
              await decisions.execute(
                { ...decision, data: { ...decision.data, confirmationToken: confirmed } },
                other.actor,
              ),
            ).toMatchObject({ result: 'succeeded' });
          }
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
        if (mode === 'assigned')
          expect(review).toMatchObject({
            status: 'in_review',
            assigned_admin_id: f.adminId,
            version: 2,
          });
        else expect(review).toEqual(beforeConfirm);
        const logs = await database
          .selectFrom('administration.admin_action_logs')
          .select(['result', 'command_code', 'metadata'])
          .where('admin_user_id', '=', f.adminId)
          .execute();
        expect(logs).toHaveLength(mode === 'cancel' ? 0 : 1);
        if (logs.length)
          expect(logs[0]).toMatchObject({
            command_code: 'moderation.assign-review',
            result: mode === 'assigned' ? 'succeeded' : 'rejected',
          });
        expect(JSON.stringify(logs)).not.toContain(reason.message.text);
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
        ).toEqual({ state: 'active' });
        expect(
          await database
            .selectFrom('notification.notifications')
            .select('id')
            .where('user_id', '=', fixture.target)
            .execute(),
        ).toHaveLength(0);
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
  },
);
