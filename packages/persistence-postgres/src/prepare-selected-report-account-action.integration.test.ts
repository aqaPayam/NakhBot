import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AesGcmReviewNoteProtector } from '@nakh/application';
import type { AccountActionDraft } from '@nakh/application';
import type { ReviewAssignmentDraft, ReviewDecisionDraft } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportFixtureAdmin, createRetainedPhotoReview } from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresGetAdminReportQueueActionsHandler } from './queue-actions-store.js';
import { PostgresGetReportMetadataPageHandler } from './report-metadata-store.js';
import { PostgresPrepareSelectedReportReviewHandler } from './prepare-selected-report-review-store.js';
import { PostgresConfirmedReviewAssignments } from './confirmed-review-assignment-store.js';
import { PostgresConfirmedReviewDecisions } from './confirmed-review-decision-store.js';
import { PostgresPrepareSelectedReportAccountActionHandler } from './prepare-selected-report-account-action-store.js';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('selected report to native Account preparation', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_account_select');
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
    Awaited<ReturnType<typeof confirmationFixture>> & { adminId: string }
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
    return { ...(await confirmationFixture(database, adminId)), adminId };
  }

  async function assign(
    f: Awaited<ReturnType<typeof operator>>,
    report: Awaited<ReturnType<typeof createRetainedPhotoReview>>,
  ): Promise<string> {
    const root = await new PostgresGetAdminReportQueueActionsHandler(
      database,
      f.tokens,
      f.key,
    ).execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
    const selected = await new PostgresPrepareSelectedReportReviewHandler(
      database,
      f.tokens,
      f.key,
    ).execute(
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
          adminActionToken: selected.adminActionToken,
          expectedTargetVersion: selected.reviewVersion,
          assigneeAdminId: selected.assigneeAdminId,
          reason: 'Own selected review',
        },
      };
    const commands = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key),
      confirmationToken = await commands.prepare(draft, f.actor);
    expect(
      await commands.execute({ ...draft, data: { ...draft.data, confirmationToken } }, f.actor),
    ).toMatchObject({ result: 'succeeded' });
    return root.metadataActionToken;
  }
  function draft(
    f: Awaited<ReturnType<typeof operator>>,
    target: { adminActionToken: string; accountVersion: number },
    action: AccountActionDraft['data']['action'],
  ): AccountActionDraft {
    const id = randomUUID();
    return {
      actor: f.actor,
      commandId: id,
      requestId: id,
      idempotencyKey: id,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      commandType: 'moderation.apply-account-action',
      data: {
        adminActionToken: target.adminActionToken,
        expectedTargetVersion: target.accountVersion,
        action,
        reason: 'Exact selected report Account action',
      },
    };
  }
  it('starts from native metadata selection and separately confirms one effect/audit/notification for each Account action under concurrency', async () => {
    const f = await operator(),
      report = await createRetainedPhotoReview(database),
      token = await assign(f, report);
    const page = await new PostgresGetReportMetadataPageHandler(database, f.tokens, f.key).execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: token,
        status: 'pending_review',
        limit: 50,
      },
      f.actor,
    );
    const item = page.items.find((item) => item.reportId === report.reportId)!;
    expect(item).toBeDefined();
    const prepare = new PostgresPrepareSelectedReportAccountActionHandler(
        database,
        f.tokens,
        f.key,
      ),
      commands = new PostgresConfirmedAccountActions(database, f.tokens, f.key);
    const other = await operator(),
      otherRoot = await new PostgresGetAdminReportQueueActionsHandler(
        database,
        other.tokens,
        other.key,
      ).execute({ actor: other.actor, requestId: randomUUID() }, other.actor);
    const query = {
      actor: f.actor,
      requestId: randomUUID(),
      adminActionToken: token,
      reportId: item.reportId,
      expectedReportVersion: item.version,
      action: 'restrict_user' as const,
    };
    await expect(
      new PostgresPrepareSelectedReportAccountActionHandler(
        database,
        other.tokens,
        other.key,
      ).execute(
        { ...query, actor: other.actor, adminActionToken: otherRoot.metadataActionToken },
        other.actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      prepare.execute({ ...query, expectedReportVersion: 1 }, f.actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    let version = 1;
    for (const [action, state] of [
      ['restrict_user', 'restricted'],
      ['unrestrict_user', 'active'],
      ['ban_user', 'banned'],
      ['unban_user', 'active'],
    ] as const) {
      const before = await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', report.target)
        .executeTakeFirstOrThrow();
      const targets = await Promise.all(
        Array.from({ length: 20 }, () => prepare.execute({ ...query, action }, f.actor)),
      );
      for (const target of targets) {
        expect(target.accountVersion).toBe(version);
        expect(Object.keys(target).sort()).toEqual(['accountVersion', 'adminActionToken']);
        expect(JSON.stringify(target)).not.toContain(report.target);
      }
      const command = draft(f, targets[0]!, action),
        confirmationToken = await commands.prepare(command, f.actor);
      expect(
        await database
          .selectFrom('identity.accounts')
          .selectAll()
          .where('user_id', '=', report.target)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      const final = { ...command, data: { ...command.data, confirmationToken } };
      const alteredDraft = draft(f, targets[0]!, action);
      const alteredToken = await commands.prepare(alteredDraft, f.actor);
      const altered = {
        ...alteredDraft,
        data: { ...alteredDraft.data, confirmationToken: alteredToken, reason: 'Changed reason' },
      };
      const rejected = await Promise.all(
        Array.from({ length: 10 }, () => commands.execute(altered, f.actor)),
      );
      expect(
        rejected.every(
          (result) => result.result === 'rejected' && result.safeCode === 'invalid_request',
        ),
      ).toBe(true);
      expect(rejected.filter((result) => !result.replayed)).toHaveLength(1);
      expect(
        await database
          .selectFrom('identity.accounts')
          .selectAll()
          .where('user_id', '=', report.target)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      await expect(
        commands.execute(
          { ...alteredDraft, data: { ...alteredDraft.data, confirmationToken: alteredToken } },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
      const results = await Promise.all(
        Array.from({ length: 20 }, () => commands.execute(final, f.actor)),
      );
      expect(results.every((result) => result.result === 'succeeded')).toBe(true);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(
        await database
          .selectFrom('identity.accounts')
          .select(['state', 'version'])
          .where('user_id', '=', report.target)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state, version: ++version });
      expect(
        await database
          .selectFrom('moderation.moderation_actions')
          .select('id')
          .where('source_report_id', '=', report.reportId)
          .where('action_type', '=', action)
          .execute(),
      ).toHaveLength(1);
    }
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'version', 'assigned_admin_id'])
        .where('id', '=', report.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'in_review', version: 2, assigned_admin_id: f.adminId });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select(['status', 'version'])
        .where('id', '=', report.reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending_review', version: 2 });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select(['result', 'metadata'])
      .where('admin_user_id', '=', f.adminId)
      .where('command_code', '=', 'moderation.apply-account-action')
      .execute();
    expect(logs).toHaveLength(8);
    expect(logs.filter((log) => log.result === 'succeeded')).toHaveLength(4);
    expect(logs.filter((log) => log.result === 'rejected')).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain('Exact selected report Account action');
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', report.target)
        .execute(),
    ).toHaveLength(4);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('report_id', '=', report.reportId)
        .execute(),
    ).toHaveLength(0);
  });
  it.each(['revoked', 'reassigned', 'closed'] as const)(
    'rejects %s authority after preparation with one native audit and no Account effect',
    async (mode) => {
      const f = await operator(),
        report = await createRetainedPhotoReview(database),
        token = await assign(f, report);
      const selector = new PostgresPrepareSelectedReportAccountActionHandler(
          database,
          f.tokens,
          f.key,
        ),
        query = {
          actor: f.actor,
          requestId: randomUUID(),
          adminActionToken: token,
          reportId: report.reportId,
          expectedReportVersion: 2,
          action: 'ban_user' as const,
        };
      const target = await selector.execute(query, f.actor),
        command = draft(f, target, 'ban_user'),
        commands = new PostgresConfirmedAccountActions(database, f.tokens, f.key),
        confirmationToken = await commands.prepare(command, f.actor);
      if (mode === 'revoked')
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .where('revoked_at', 'is', null)
          .execute();
      if (mode === 'reassigned') await assign(await operator(), report);
      if (mode === 'closed') {
        const selected = await new PostgresPrepareSelectedReportReviewHandler(
            database,
            f.tokens,
            f.key,
          ).execute({ ...query, action: 'dismissed' }, f.actor),
          id = randomUUID();
        const decision: ReviewDecisionDraft = {
          ...command,
          commandId: id,
          requestId: id,
          idempotencyKey: id,
          commandType: 'moderation.decide-review',
          data: {
            adminActionToken: selected.adminActionToken,
            expectedTargetVersion: selected.reviewVersion,
            decision: 'dismissed',
            reason: 'Close selected review',
          },
        };
        const native = new PostgresConfirmedReviewDecisions(
            database,
            f.tokens,
            f.key,
            new AesGcmReviewNoteProtector('test-report-note', 1, Buffer.alloc(32, 4)),
          ),
          confirmed = await native.prepare(decision, f.actor);
        expect(
          await native.execute(
            { ...decision, data: { ...decision.data, confirmationToken: confirmed } },
            f.actor,
          ),
        ).toMatchObject({ result: 'succeeded' });
      }
      await expect(selector.execute(query, f.actor)).rejects.toMatchObject({
        status: mode === 'closed' ? 409 : 403,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          commands.execute({ ...command, data: { ...command.data, confirmationToken } }, f.actor),
        ),
      );
      expect(results.every((result) => result.result === 'rejected')).toBe(true);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(
        await database
          .selectFrom('identity.accounts')
          .select(['state', 'version'])
          .where('user_id', '=', report.target)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'active', version: 1 });
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', f.adminId)
          .where('command_code', '=', 'moderation.apply-account-action')
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('notification.notifications')
          .select('id')
          .where('user_id', '=', report.target)
          .execute(),
      ).toHaveLength(0);
    },
  );
});
