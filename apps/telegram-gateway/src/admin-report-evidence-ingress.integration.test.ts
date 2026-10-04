import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmReviewNoteProtector,
  type ReviewAssignmentDraft,
  type ReviewDecisionDraft,
} from '@nakh/application';
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
  createRetainedReportPhoto,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Menu = { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
describe.skipIf(url === undefined)('actual private report evidence metadata ingress', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_evidence_ui');
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
  async function operator(
    viewOnly = true,
  ): Promise<
    Awaited<ReturnType<typeof confirmationFixture>> & { adminId: string; telegramUserId: string }
  > {
    const adminId = await createReportFixtureAdmin(database);
    const role = viewOnly ? `evidence_view_${adminId.replaceAll('-', '')}` : 'moderator';
    if (viewOnly) {
      await database
        .insertInto('administration.admin_roles')
        .values({ code: role, description: 'Synthetic metadata-only fixture' })
        .execute();
      await database
        .insertInto('administration.admin_role_permissions')
        .values({ role_code: role, permission_code: 'view_reports' })
        .execute();
    }
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: role,
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
  async function dismiss(
    report: Awaited<ReturnType<typeof createRetainedPhotoReview>>,
  ): Promise<void> {
    const f = await operator(false);
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
        reportId: report.reportId,
        expectedReportVersion: 2,
        action: 'assign',
      },
      f.actor,
    );
    const id = randomUUID();
    const assignment: ReviewAssignmentDraft = {
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
        reason: 'Own fixture review',
      },
    };
    const assignments = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key);
    const assignmentToken = await assignments.prepare(assignment, f.actor);
    expect(
      await assignments.execute(
        { ...assignment, data: { ...assignment.data, confirmationToken: assignmentToken } },
        f.actor,
      ),
    ).toMatchObject({ result: 'succeeded' });
    const selected = await selector.execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        reportId: report.reportId,
        expectedReportVersion: 2,
        action: 'dismissed',
      },
      f.actor,
    );
    const decisionId = randomUUID();
    const decision: ReviewDecisionDraft = {
      actor: f.actor,
      commandId: decisionId,
      requestId: decisionId,
      idempotencyKey: decisionId,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      commandType: 'moderation.decide-review',
      data: {
        adminActionToken: selected.adminActionToken,
        expectedTargetVersion: selected.reviewVersion,
        decision: 'dismissed',
        reason: 'Dismiss fixture review',
      },
    };
    const decisions = new PostgresConfirmedReviewDecisions(
      database,
      f.tokens,
      f.key,
      new AesGcmReviewNoteProtector('synthetic-note-key', 1, new Uint8Array(32).fill(7)),
    );
    const confirmationToken = await decisions.prepare(decision, f.actor);
    expect(
      await decisions.execute(
        { ...decision, data: { ...decision.data, confirmationToken } },
        f.actor,
      ),
    ).toMatchObject({ result: 'succeeded' });
  }
  function harness(f: Awaited<ReturnType<typeof operator>>): {
    sent: string[];
    state: TelegramAdminReportQueueState;
    callback: (data: string, updateId?: number) => Promise<'notice' | 'unhandled'>;
    queue: (status: string) => Promise<'notice' | 'unhandled'>;
    ingress: ReturnType<typeof createTelegramAdminSafetyReadIngress>;
  } {
    const sent: string[] = [],
      now = new Date();
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
    const from = { id: Number(f.telegramUserId), is_bot: false },
      chat = { id: Number(f.telegramUserId), type: 'private' };
    let updateId = 100;
    return {
      sent,
      ingress,
      state: new TelegramAdminReportQueueState(
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      ),
      callback: (data, id) =>
        ingress.handle({
          update_id: id ?? updateId++,
          callback_query: { from, data, message: { chat } },
        }),
      queue: (status) =>
        ingress.handle({
          update_id: updateId++,
          message: {
            from,
            chat,
            date: Math.floor(now.getTime() / 1000),
            text: `/admin_reports ${status}`,
          },
        }),
    };
  }
  async function choose(
    h: ReturnType<typeof harness>,
    f: Awaited<ReturnType<typeof operator>>,
    reportId: string,
    status: string,
  ): Promise<string> {
    await h.queue(status);
    for (let page = 0; page < 20; page++) {
      const rows = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup.inline_keyboard;
      for (const data of rows.flat().map((button) => button.callback_data)) {
        if (
          data.startsWith('m7T:') &&
          (await h.state.choice(f.actor, data.slice(4)))?.targetId === reportId
        ) {
          await h.callback(data);
          const options = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup.inline_keyboard
            .flat()
            .map((button) => button.callback_data);
          expect(options).toEqual(
            (status === 'pending_review' ? ['I', 'C'] : ['C']).map((code) =>
              data.replace('m7T:', `m7${code}:`),
            ),
          );
          await h.callback(data.replace('m7T:', 'm7C:'));
          const selection = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup
            .inline_keyboard[0]![0]!.callback_data;
          expect(selection).toMatch(/^m7J:[A-Za-z0-9_-]{22}$/u);
          return selection;
        }
      }
      const next = rows.flat().find((button) => button.callback_data.startsWith('m7O:'));
      expect(next).toBeDefined();
      await h.callback(next!.callback_data);
    }
    throw new Error('Synthetic selected report not found');
  }
  async function noViewerEffects(
    f: Awaited<ReturnType<typeof operator>>,
    report: Awaited<ReturnType<typeof createRetainedReportPhoto>>,
  ): Promise<void> {
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('admin_user_id', '=', f.adminId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('admin_user_id', '=', f.adminId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('media.profile_photos')
        .select(['status', 'version'])
        .where('id', '=', report.photoId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'visible', version: 1 });
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', report.target)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'active', version: 1 });
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
  }
  it.each(['submitted', 'dismissed'] as const)(
    'browses %s evidence with only view_reports and no assignment/content/effect under retries',
    async (status) => {
      const f = await operator(),
        review = status === 'dismissed' ? await createRetainedPhotoReview(database) : undefined,
        report = review ?? (await createRetainedReportPhoto(database));
      if (review !== undefined) await dismiss(review);
      const h = harness(f);
      const selected = await choose(h, f, report.reportId, status);
      const stored = await h.state.evidence(f.actor, selected.slice(4));
      expect(stored).toMatchObject({
        evidenceId: report.evidenceId,
        evidenceType: 'photo',
        snapshotSchemaVersion: 1,
      });
      expect(
        await Promise.all(Array.from({ length: 10 }, () => h.callback(selected, 900))),
      ).toEqual(Array(10).fill('notice'));
      expect(h.sent.at(-1)).toContain('admin.report.evidence_selected');
      for (const encoded of h.sent) {
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
      expect(
        await database
          .selectFrom('moderation.moderation_reviews')
          .select('id')
          .where('report_id', '=', report.reportId)
          .execute(),
      ).toHaveLength(status === 'submitted' ? 0 : 1);
      await noViewerEffects(f, report);
    },
  );
  it('rejects old version, borrowed actor and revoked native permission before any metadata selection notice', async () => {
    const f = await operator(),
      report = await createRetainedPhotoReview(database),
      h = harness(f);
    const selected = await choose(h, f, report.reportId, 'pending_review');
    await dismiss(report);
    await h.callback(selected);
    expect(h.sent.at(-1)).toContain('error.m7.stale_action');
    const fresh = await choose(h, f, report.reportId, 'dismissed');
    const other = await operator();
    const borrowed = harness({ ...other, tokens: f.tokens });
    await borrowed.callback(fresh);
    expect(borrowed.sent.at(-1)).toContain('error.m7.unavailable');
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
      .where('admin_user_id', '=', f.adminId)
      .execute();
    const before = h.sent.length;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => h.callback(fresh, 901)),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 500 });
    expect(await Promise.all(Array.from({ length: 10 }, () => h.callback(fresh, 901)))).toEqual(
      Array(10).fill('notice'),
    );
    expect(
      h.sent.slice(before).every((message) => !message.includes('admin.report.evidence_selected')),
    ).toBe(true);
    await noViewerEffects(f, report);
  });
});
