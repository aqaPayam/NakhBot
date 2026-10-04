import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AesGcmReviewNoteProtector } from '@nakh/application';
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

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('selected report to native review preparation', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_review_select');
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
  it('resolves metadata selection, requires distinct confirmation, and replays one own-assignment and dismissal audit under concurrency', async () => {
    const f = await operator(),
      fixture = await createRetainedPhotoReview(database);
    const queues = new PostgresGetAdminReportQueueActionsHandler(database, f.tokens, f.key);
    const root = await queues.execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
    const page = await new PostgresGetReportMetadataPageHandler(database, f.tokens, f.key).execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        status: 'pending_review',
        limit: 50,
      },
      f.actor,
    );
    const item = page.items.find((item) => item.reportId === fixture.reportId)!;
    expect(item).toBeDefined();
    expect(JSON.stringify(page)).not.toContain(fixture.reporter);
    const selection = new PostgresPrepareSelectedReportReviewHandler(database, f.tokens, f.key);
    const query = {
      actor: f.actor,
      requestId: randomUUID(),
      adminActionToken: root.metadataActionToken,
      reportId: item.reportId,
      expectedReportVersion: item.version,
      action: 'assign' as const,
    };
    const prepared = await Promise.all(
      Array.from({ length: 20 }, () => selection.execute(query, f.actor)),
    );
    for (const value of prepared)
      expect(value).toMatchObject({
        reviewId: fixture.reviewId,
        reviewVersion: 1,
        assigneeAdminId: f.adminId,
      });
    const before = await database
      .selectFrom('moderation.moderation_reviews')
      .selectAll()
      .where('id', '=', fixture.reviewId)
      .executeTakeFirstOrThrow();
    expect(before).toMatchObject({ status: 'pending', assigned_admin_id: null, version: 1 });
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
    const first = prepared[0]!,
      commandId = randomUUID();
    const draft: ReviewAssignmentDraft = {
      actor: f.actor,
      commandId,
      requestId: commandId,
      idempotencyKey: commandId,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      commandType: 'moderation.assign-review',
      data: {
        adminActionToken: first.adminActionToken,
        expectedTargetVersion: first.reviewVersion,
        assigneeAdminId: first.assigneeAdminId,
        reason: 'Take responsibility for selected report',
      },
    };
    const assignments = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key);
    const confirmationToken = await assignments.prepare(draft, f.actor);
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .selectAll()
        .where('id', '=', fixture.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    const command = { ...draft, data: { ...draft.data, confirmationToken } };
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => assignments.execute(command, f.actor)),
    );
    expect(outcomes.every((outcome) => outcome.result === 'succeeded')).toBe(true);
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'version', 'assigned_admin_id'])
        .where('id', '=', fixture.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'in_review', version: 2, assigned_admin_id: f.adminId });
    const other = await operator();
    const otherRoot = await new PostgresGetAdminReportQueueActionsHandler(
      database,
      other.tokens,
      other.key,
    ).execute({ actor: other.actor, requestId: randomUUID() }, other.actor);
    await expect(
      new PostgresPrepareSelectedReportReviewHandler(database, other.tokens, other.key).execute(
        {
          ...query,
          actor: other.actor,
          adminActionToken: otherRoot.metadataActionToken,
          action: 'dismissed',
        },
        other.actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      selection.execute({ ...query, action: 'actioned' }, f.actor),
    ).rejects.toMatchObject({ code: 'conflict' });
    const decision = await selection.execute({ ...query, action: 'dismissed' }, f.actor);
    expect(decision.reviewVersion).toBe(2);
    const decisionId = randomUUID();
    const decisionDraft: ReviewDecisionDraft = {
      ...draft,
      commandId: decisionId,
      requestId: decisionId,
      idempotencyKey: decisionId,
      commandType: 'moderation.decide-review',
      data: {
        adminActionToken: decision.adminActionToken,
        expectedTargetVersion: decision.reviewVersion,
        decision: 'dismissed',
        reason: 'Dismiss selected report after review',
      },
    };
    const decisions = new PostgresConfirmedReviewDecisions(
      database,
      f.tokens,
      f.key,
      new AesGcmReviewNoteProtector('review-note-test', 1, Buffer.alloc(32, 3)),
    );
    const decisionConfirmation = await decisions.prepare(decisionDraft, f.actor);
    const final = await Promise.all(
      Array.from({ length: 10 }, () =>
        decisions.execute(
          {
            ...decisionDraft,
            data: { ...decisionDraft.data, confirmationToken: decisionConfirmation },
          },
          f.actor,
        ),
      ),
    );
    expect(final.every((value) => value.result === 'succeeded')).toBe(true);
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('status')
        .where('id', '=', fixture.reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'dismissed' });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select(['command_code', 'result', 'metadata'])
      .where('admin_user_id', '=', f.adminId)
      .execute();
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.result === 'succeeded')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(draft.data.reason);
    expect(JSON.stringify(logs)).not.toContain(decisionDraft.data.reason);
    const terminalReport = await database
      .selectFrom('moderation.reports')
      .select('version')
      .where('id', '=', fixture.reportId)
      .executeTakeFirstOrThrow();
    await expect(selection.execute(query, f.actor)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    await expect(
      selection.execute({ ...query, expectedReportVersion: terminalReport.version }, f.actor),
    ).rejects.toMatchObject({ code: 'conflict' });
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
  });
  it.each(['revoked', 'reassigned', 'changed_confirmation'] as const)(
    'keeps prepared selection subordinate to native %s checks and one rejection audit',
    async (mode) => {
      const f = await operator(),
        fixture = await createRetainedPhotoReview(database);
      const root = await new PostgresGetAdminReportQueueActionsHandler(
        database,
        f.tokens,
        f.key,
      ).execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
      const selection = new PostgresPrepareSelectedReportReviewHandler(database, f.tokens, f.key);
      const query = {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        reportId: fixture.reportId,
        expectedReportVersion: 2,
        action: 'assign' as const,
      };
      await expect(
        selection.execute({ ...query, expectedReportVersion: 1 }, f.actor),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      await expect(
        selection.execute({ ...query, reportId: randomUUID() }, f.actor),
      ).rejects.toMatchObject({ code: 'not_found' });
      const target = await selection.execute(query, f.actor),
        commandId = randomUUID();
      const draft: ReviewAssignmentDraft = {
        actor: f.actor,
        commandId,
        requestId: commandId,
        idempotencyKey: commandId,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        commandType: 'moderation.assign-review',
        data: {
          adminActionToken: target.adminActionToken,
          expectedTargetVersion: target.reviewVersion,
          assigneeAdminId: target.assigneeAdminId,
          reason: 'Own selected review',
        },
      };
      const assignments = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key);
      const confirmationToken = await assignments.prepare(draft, f.actor);
      let assignee = target.assigneeAdminId;
      if (mode === 'revoked') {
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .where('revoked_at', 'is', null)
          .execute();
        await expect(selection.execute(query, f.actor)).rejects.toMatchObject({ status: 403 });
      } else if (mode === 'reassigned') {
        const other = await operator();
        const otherRoot = await new PostgresGetAdminReportQueueActionsHandler(
          database,
          other.tokens,
          other.key,
        ).execute({ actor: other.actor, requestId: randomUUID() }, other.actor);
        const competing = await new PostgresPrepareSelectedReportReviewHandler(
          database,
          other.tokens,
          other.key,
        ).execute(
          { ...query, actor: other.actor, adminActionToken: otherRoot.metadataActionToken },
          other.actor,
        );
        const id = randomUUID(),
          native = new PostgresConfirmedReviewAssignments(database, other.tokens, other.key);
        const competingDraft: ReviewAssignmentDraft = {
          ...draft,
          actor: other.actor,
          commandId: id,
          requestId: id,
          idempotencyKey: id,
          data: {
            ...draft.data,
            adminActionToken: competing.adminActionToken,
            expectedTargetVersion: competing.reviewVersion,
            assigneeAdminId: competing.assigneeAdminId,
          },
        };
        const confirmed = await native.prepare(competingDraft, other.actor);
        expect(
          await native.execute(
            { ...competingDraft, data: { ...competingDraft.data, confirmationToken: confirmed } },
            other.actor,
          ),
        ).toMatchObject({ result: 'succeeded' });
      } else assignee = (await operator()).adminId;
      const before = await database
        .selectFrom('moderation.moderation_reviews')
        .selectAll()
        .where('id', '=', fixture.reviewId)
        .executeTakeFirstOrThrow();
      const command = {
        ...draft,
        data: { ...draft.data, assigneeAdminId: assignee, confirmationToken },
      };
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => assignments.execute(command, f.actor)),
      );
      expect(outcomes.every((value) => value.result === 'rejected')).toBe(true);
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
          .select(['result'])
          .where('command_id', '=', commandId)
          .execute(),
      ).toEqual([{ result: 'rejected' }]);
    },
  );
});
