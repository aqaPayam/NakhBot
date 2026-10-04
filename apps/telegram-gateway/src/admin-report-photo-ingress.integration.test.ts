import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmReviewNoteProtector,
  type PhotoActionDraft,
  type ReviewAssignmentDraft,
  type ReviewDecisionDraft,
} from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresPrepareSelectedReportReviewHandler,
  PostgresConfirmedReviewAssignments,
  PostgresPrepareSelectedReportPhotoActionHandler,
  PostgresConfirmedPhotoActions,
  PostgresConfirmedReviewDecisions,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramAdminTextDelivery, TelegramAdminReportQueueState } from '@nakh/telegram';
import {
  createReportFixtureAdmin,
  createRetainedPhotoReview,
  createReportPhoto,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
type Menu = { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
describe.skipIf(url === undefined)('actual selected evidence and confirmed photo ingress', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_photo_ui');
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
  async function assign(
    f: Awaited<ReturnType<typeof operator>>,
    reportId: string,
  ): Promise<string> {
    const root = await new PostgresGetAdminReportQueueActionsHandler(
      database,
      f.tokens,
      f.key,
    ).execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
    const target = await new PostgresPrepareSelectedReportReviewHandler(
      database,
      f.tokens,
      f.key,
    ).execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        reportId,
        expectedReportVersion: 2,
        action: 'assign',
      },
      f.actor,
    );
    const id = randomUUID(),
      draft: ReviewAssignmentDraft = {
        actor: f.actor,
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
          reason: 'Own exact photo review',
        },
      };
    const commands = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key),
      confirmationToken = await commands.prepare(draft, f.actor);
    expect(
      await commands.execute({ ...draft, data: { ...draft.data, confirmationToken } }, f.actor),
    ).toMatchObject({ result: 'succeeded' });
    return root.metadataActionToken;
  }
  async function nativeHide(
    f: Awaited<ReturnType<typeof operator>>,
    report: Awaited<ReturnType<typeof createRetainedPhotoReview>>,
    root: string,
  ): Promise<void> {
    const target = await new PostgresPrepareSelectedReportPhotoActionHandler(
      database,
      f.tokens,
      f.key,
    ).execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: root,
        reportId: report.reportId,
        expectedReportVersion: 2,
        evidenceId: report.evidenceId,
        action: 'hide_photo',
      },
      f.actor,
    );
    const id = randomUUID(),
      draft: PhotoActionDraft = {
        actor: f.actor,
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        commandType: 'moderation.apply-photo-action',
        data: {
          adminActionToken: target.adminActionToken,
          expectedTargetVersion: target.photoVersion,
          action: 'hide_photo',
          reason: 'Independent native fixture hide',
        },
      };
    const commands = new PostgresConfirmedPhotoActions(database, f.tokens, f.key, {
        execute: () => Promise.resolve(),
      }),
      confirmationToken = await commands.prepare(draft, f.actor);
    expect(
      await commands.execute({ ...draft, data: { ...draft.data, confirmationToken } }, f.actor),
    ).toMatchObject({ result: 'succeeded' });
  }
  it.each([
    'hide_photo',
    'restore_photo',
    'delete_photo',
    'cancel',
    'revoked',
    'reassigned',
    'stale',
    'closed',
  ] as const)(
    'records one %s outcome with native confirmation, retention and concurrency',
    async (mode) => {
      const f = await operator(),
        report = await createRetainedPhotoReview(database),
        root = await assign(f, report.reportId);
      await createReportPhoto(database, report.target, false);
      if (mode === 'restore_photo') await nativeHide(f, report, root);
      const now = new Date(),
        sent: string[] = [],
        purged: string[] = [];
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
        photoDelivery: {
          execute: (id) => {
            purged.push(id);
            return Promise.resolve();
          },
        },
      });
      const state = new TelegramAdminReportQueueState(
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      const from = { id: Number(f.telegramUserId), is_bot: false },
        chat = { id: Number(f.telegramUserId), type: 'private' };
      let updateId = 100;
      const callback = (data: string, id = updateId++): Promise<'notice' | 'unhandled'> =>
        ingress.handle({ update_id: id, callback_query: { from, data, message: { chat } } });
      await ingress.handle({
        update_id: updateId++,
        message: { from, chat, date: Math.floor(now.getTime() / 1000), text: '/admin_reports' },
      });
      let reference: string | undefined;
      for (let page = 0; page < 20; page++) {
        const rows = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard;
        for (const data of rows.flat().map((button) => button.callback_data))
          if (
            data.startsWith('m7T:') &&
            (await state.choice(f.actor, data.slice(4)))?.targetId === report.reportId
          )
            reference = data.slice(4);
        if (reference !== undefined) break;
        const next = rows.flat().find((button) => button.callback_data.startsWith('m7O:'));
        expect(next).toBeDefined();
        await callback(next!.callback_data);
      }
      expect(reference).toBeDefined();
      await callback(`m7T:${reference}`);
      expect(
        (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
          .flat()
          .some((button) => button.callback_data === `m7C:${reference}`),
      ).toBe(true);
      await callback(`m7C:${reference}`);
      const evidenceData = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
        .callback_data;
      expect(await state.evidence(f.actor, evidenceData.slice(4))).toMatchObject({
        evidenceId: report.evidenceId,
      });
      await callback(evidenceData);
      const options = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
        .flat()
        .map((button) => button.callback_data);
      expect(options.map((data) => data.slice(2, 3))).toEqual(
        mode === 'restore_photo' ? ['S', 'P'] : ['V', 'P'],
      );
      const code = mode === 'restore_photo' ? 'S' : mode === 'delete_photo' ? 'P' : 'V';
      await callback(`m7${code}:${evidenceData.slice(4)}`);
      const promptId = sent.length;
      expect(await state.promptSelection(f.actor, promptId)).toBeUndefined();
      expect(await state.photoPrompt(f.actor, promptId)).toMatchObject({
        reference: evidenceData.slice(4),
      });
      const before = await database
        .selectFrom('media.profile_photos')
        .selectAll()
        .where('id', '=', report.photoId)
        .executeTakeFirstOrThrow();
      const reason = {
        update_id: updateId++,
        message: {
          from,
          chat,
          date: Math.floor(now.getTime() / 1000),
          text: 'Exact selected photo action reason',
          reply_to_message: { message_id: promptId, from: { id: 123, is_bot: true } },
        },
      };
      expect(await Promise.all(Array.from({ length: 10 }, () => ingress.handle(reason)))).toEqual(
        Array(10).fill('notice'),
      );
      const confirmation = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
        .callback_data;
      expect(confirmation).toMatch(/^m7L:[A-Za-z0-9_-]{22}$/u);
      expect(purged).toHaveLength(0);
      expect(
        await database
          .selectFrom('media.profile_photos')
          .selectAll()
          .where('id', '=', report.photoId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      if (mode === 'revoked')
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .execute();
      if (mode === 'reassigned') await assign(await operator(), report.reportId);
      if (mode === 'stale') await nativeHide(f, report, root);
      if (mode === 'closed') {
        const selected = await new PostgresPrepareSelectedReportReviewHandler(
          database,
          f.tokens,
          f.key,
        ).execute(
          {
            actor: f.actor,
            requestId: randomUUID(),
            adminActionToken: root,
            reportId: report.reportId,
            expectedReportVersion: 2,
            action: 'dismissed',
          },
          f.actor,
        );
        const id = randomUUID(),
          draft: ReviewDecisionDraft = {
            actor: f.actor,
            commandId: id,
            requestId: id,
            idempotencyKey: id,
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            locale: 'en',
            commandType: 'moderation.decide-review',
            data: {
              adminActionToken: selected.adminActionToken,
              expectedTargetVersion: selected.reviewVersion,
              decision: 'dismissed',
              reason: 'Independent dismissal',
            },
          };
        const decisions = new PostgresConfirmedReviewDecisions(
            database,
            f.tokens,
            f.key,
            new AesGcmReviewNoteProtector('fixture', 1, new Uint8Array(32).fill(7)),
          ),
          confirmationToken = await decisions.prepare(draft, f.actor);
        expect(
          await decisions.execute(
            { ...draft, data: { ...draft.data, confirmationToken } },
            f.actor,
          ),
        ).toMatchObject({ result: 'succeeded' });
      }
      if (mode === 'cancel') {
        await callback(confirmation.replace('m7L:', 'm7N:'));
        const attempts = await Promise.allSettled(
          Array.from({ length: 10 }, () => callback(confirmation, 900)),
        );
        expect(attempts.some((result) => result.status === 'fulfilled')).toBe(true);
        for (const result of attempts)
          if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 500 });
      }
      expect(
        await Promise.all(Array.from({ length: 10 }, () => callback(confirmation, 900))),
      ).toEqual(Array(10).fill('notice'));
      const success = mode === 'hide_photo' || mode === 'restore_photo' || mode === 'delete_photo';
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('admin_user_id', '=', f.adminId)
        .where('command_code', '=', 'moderation.apply-photo-action')
        .execute();
      const seeded = mode === 'restore_photo' || mode === 'stale' ? 1 : 0;
      expect(logs).toHaveLength(seeded + (mode === 'cancel' ? 0 : 1));
      expect(logs.filter((log) => log.result === 'succeeded')).toHaveLength(
        seeded + (success ? 1 : 0),
      );
      expect(logs.filter((log) => log.result === 'rejected')).toHaveLength(
        !success && mode !== 'cancel' ? 1 : 0,
      );
      if (mode === 'stale')
        expect(logs.some((log) => log.safe_code === 'version_conflict')).toBe(true);
      expect(
        await database
          .selectFrom('media.profile_photos')
          .select(['status', 'version'])
          .where('id', '=', report.photoId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status:
          mode === 'delete_photo'
            ? 'deleted'
            : mode === 'hide_photo' || mode === 'stale'
              ? 'hidden'
              : 'visible',
        version: before.version + (success || mode === 'stale' ? 1 : 0),
      });
      expect(
        await database
          .selectFrom('moderation.moderation_actions')
          .select('id')
          .where('source_report_id', '=', report.reportId)
          .where('action_type', 'in', ['hide_photo', 'restore_photo', 'delete_photo'])
          .execute(),
      ).toHaveLength(seeded + (success ? 1 : 0));
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select('id')
          .where('admin_user_id', '=', f.adminId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('identity.accounts')
          .select(['state', 'version'])
          .where('user_id', '=', report.target)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'active', version: 1 });
      expect(
        await database
          .selectFrom('moderation.reports')
          .select(['status', 'version'])
          .where('id', '=', report.reportId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status: mode === 'closed' ? 'dismissed' : 'pending_review',
        version: mode === 'closed' ? 3 : 2,
      });
      expect(
        await database
          .selectFrom('media.report_photo_evidence_holds')
          .select('report_evidence_id')
          .where('report_evidence_id', '=', report.evidenceId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('moderation.report_snapshots')
          .select('id')
          .where('report_evidence_id', '=', report.evidenceId)
          .execute(),
      ).toHaveLength(1);
      const asset = await database
        .selectFrom('media.media_assets')
        .select('storage_deleted_at')
        .where('id', '=', before.asset_id)
        .executeTakeFirstOrThrow();
      expect(asset.storage_deleted_at).toBeNull();
      expect(purged.every((id) => id === report.photoId)).toBe(true);
      if (mode === 'restore_photo' || mode === 'cancel') expect(purged).toHaveLength(0);
      if (mode === 'hide_photo' || mode === 'delete_photo')
        expect(purged.length).toBeGreaterThan(0);
      for (const encoded of sent) {
        expect(JSON.parse(encoded)).toMatchObject({
          protect_content: true,
          link_preview_options: { is_disabled: true },
        });
        for (const secret of [
          report.reportId,
          report.photoId,
          report.evidenceId,
          report.reporter,
          report.target,
          f.actor.userId,
          f.adminId,
          report.content.evidenceObjectRef,
        ])
          expect(encoded).not.toContain(secret);
      }
    },
  );
});
