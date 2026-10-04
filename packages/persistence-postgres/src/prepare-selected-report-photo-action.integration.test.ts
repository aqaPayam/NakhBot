import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AesGcmReviewNoteProtector } from '@nakh/application';
import type { PhotoActionDraft } from '@nakh/application';
import type { ReviewAssignmentDraft, ReviewDecisionDraft } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import {
  createReportFixtureAdmin,
  createRetainedPhotoReview,
  createRetainedReportPhoto,
  createReportPhoto,
} from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresGetAdminReportQueueActionsHandler } from './queue-actions-store.js';
import { PostgresGetReportMetadataPageHandler } from './report-metadata-store.js';
import { PostgresPrepareSelectedReportReviewHandler } from './prepare-selected-report-review-store.js';
import { PostgresConfirmedReviewAssignments } from './confirmed-review-assignment-store.js';
import { PostgresConfirmedReviewDecisions } from './confirmed-review-decision-store.js';
import { PostgresPrepareSelectedReportPhotoActionHandler } from './prepare-selected-report-photo-action-store.js';
import { PostgresConfirmedPhotoActions } from './confirmed-photo-store.js';
import { PostgresGetSelectedReportEvidenceMetadataHandler } from './selected-report-evidence-metadata-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('selected report to native photo preparation', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_photo_select');
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
    target: { adminActionToken: string; photoVersion: number },
    action: PhotoActionDraft['data']['action'],
  ): PhotoActionDraft {
    const id = randomUUID();
    return {
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
        action,
        reason: 'Exact selected report photo action',
      },
    };
  }
  it('starts from native metadata selection and separately confirms one photo effect/audit for each action and retains evidence under concurrency', async () => {
    const f = await operator(),
      report = await createRetainedPhotoReview(database),
      token = await assign(f, report);
    await createReportPhoto(database, report.target, false);
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
    const prepare = new PostgresPrepareSelectedReportPhotoActionHandler(database, f.tokens, f.key),
      commands = new PostgresConfirmedPhotoActions(database, f.tokens, f.key, {
        execute: () => Promise.resolve(),
      });
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
      evidenceId: report.evidenceId,
      action: 'hide_photo' as const,
    };
    await expect(
      new PostgresPrepareSelectedReportPhotoActionHandler(
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
    const metadata = await new PostgresGetSelectedReportEvidenceMetadataHandler(
      database,
      f.tokens,
      f.key,
    ).execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: token,
        reportId: item.reportId,
        expectedReportVersion: item.version,
      },
      f.actor,
    );
    expect(metadata).toEqual({
      reportId: report.reportId,
      items: [{ evidenceId: report.evidenceId, evidenceType: 'photo', snapshotSchemaVersion: 1 }],
    });
    expect(JSON.stringify(metadata)).not.toContain(report.photoId);
    const foreign = await createRetainedPhotoReview(database);
    await expect(
      prepare.execute({ ...query, evidenceId: foreign.evidenceId }, f.actor),
    ).rejects.toMatchObject({ status: 404 });
    let version = 1;
    for (const [action, state] of [
      ['hide_photo', 'hidden'],
      ['restore_photo', 'visible'],
      ['delete_photo', 'deleted'],
    ] as const) {
      const before = await database
        .selectFrom('media.profile_photos')
        .selectAll()
        .where('id', '=', report.photoId)
        .executeTakeFirstOrThrow();
      const targets = await Promise.all(
        Array.from({ length: 20 }, () => prepare.execute({ ...query, action }, f.actor)),
      );
      for (const target of targets) {
        expect(target.photoVersion).toBe(version);
        expect(Object.keys(target).sort()).toEqual(['adminActionToken', 'photoVersion']);
        expect(JSON.stringify(target)).not.toContain(report.target);
      }
      const command = draft(f, targets[0]!, action),
        confirmationToken = await commands.prepare(command, f.actor);
      expect(
        await database
          .selectFrom('media.profile_photos')
          .selectAll()
          .where('id', '=', report.photoId)
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
          .selectFrom('media.profile_photos')
          .selectAll()
          .where('id', '=', report.photoId)
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
          .selectFrom('media.profile_photos')
          .select(['status', 'version'])
          .where('id', '=', report.photoId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: state, version: ++version });
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
      .where('command_code', '=', 'moderation.apply-photo-action')
      .execute();
    expect(logs).toHaveLength(6);
    expect(logs.filter((log) => log.result === 'succeeded')).toHaveLength(3);
    expect(logs.filter((log) => log.result === 'rejected')).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain('Exact selected report photo action');
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
    const photo = await database
      .selectFrom('media.profile_photos')
      .select('asset_id')
      .where('id', '=', report.photoId)
      .executeTakeFirstOrThrow();
    expect(
      await database
        .selectFrom('media.media_assets')
        .select('storage_deleted_at')
        .where('id', '=', photo.asset_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ storage_deleted_at: null });
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('report_id', '=', report.reportId)
        .execute(),
    ).toHaveLength(0);
  });
  it.each(['revoked', 'reassigned', 'closed'] as const)(
    'rejects %s authority after preparation with one native audit and no photo effect',
    async (mode) => {
      const f = await operator(),
        report = await createRetainedPhotoReview(database),
        token = await assign(f, report);
      const selector = new PostgresPrepareSelectedReportPhotoActionHandler(
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
          evidenceId: report.evidenceId,
          action: 'hide_photo' as const,
        };
      const target = await selector.execute(query, f.actor),
        command = draft(f, target, 'hide_photo'),
        commands = new PostgresConfirmedPhotoActions(database, f.tokens, f.key, {
          execute: () => Promise.resolve(),
        }),
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
      if (mode === 'closed') {
        const metadata = await new PostgresGetSelectedReportEvidenceMetadataHandler(
          database,
          f.tokens,
          f.key,
        ).execute(
          {
            actor: f.actor,
            requestId: randomUUID(),
            adminActionToken: token,
            reportId: report.reportId,
            expectedReportVersion: 3,
          },
          f.actor,
        );
        expect(metadata.items).toHaveLength(1);
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
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', f.adminId)
          .where('command_code', '=', 'moderation.apply-photo-action')
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
  it('lists submitted Report evidence without a review or an evidence reveal/audit', async () => {
    const f = await operator(),
      report = await createRetainedReportPhoto(database);
    const root = await new PostgresGetAdminReportQueueActionsHandler(
      database,
      f.tokens,
      f.key,
    ).execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
    const metadata = await new PostgresGetSelectedReportEvidenceMetadataHandler(
      database,
      f.tokens,
      f.key,
    ).execute(
      {
        actor: f.actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        reportId: report.reportId,
        expectedReportVersion: 1,
      },
      f.actor,
    );
    expect(metadata).toEqual({
      reportId: report.reportId,
      items: [{ evidenceId: report.evidenceId, evidenceType: 'photo', snapshotSchemaVersion: 1 }],
    });
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select('id')
        .where('report_id', '=', report.reportId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('report_id', '=', report.reportId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('admin_user_id', '=', f.adminId)
        .execute(),
    ).toHaveLength(0);
    for (const secret of [report.photoId, report.reporter, report.target])
      expect(JSON.stringify(metadata)).not.toContain(secret);
  });
});
