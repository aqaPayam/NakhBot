import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import {
  PrepareReportAccountActionHandler,
  type ReportAccountActionPreparationStore,
} from './prepare-report-account-action.js';
describe('report-bound account action preparation', () => {
  it('binds server-selected targets and versions and rejects borrowed or stale reviews', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID();
    const authorize = vi.fn<AdminActionAuthorizationService['authorize']>(() =>
      Promise.resolve({
        adminUserId,
        actorUserId: actor.userId,
        commandCode: 'moderation.report-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report_queue',
        targetId: null,
        expectedTargetVersion: null,
      }),
    );
    const issue = vi.fn<AdminActionAuthorizationService['issue']>(() =>
      Promise.resolve('account-token'),
    );
    const facts = {
      reviewVersion: 2,
      reviewStatus: 'in_review',
      assignedAdminId: adminUserId,
      reportId: randomUUID(),
      reportStatus: 'pending_review',
      targetUserId: randomUUID(),
      accountVersion: 7,
    };
    const get = vi.fn<ReportAccountActionPreparationStore['get']>(() => Promise.resolve(facts));
    const handler = new PrepareReportAccountActionHandler(
      { authorize, issue },
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }) },
      { get },
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: 'queue-token',
      reviewId: randomUUID(),
      expectedReviewVersion: 2,
      action: 'ban_user' as const,
    };
    expect(await handler.execute(query, actor)).toEqual({
      adminActionToken: 'account-token',
      accountVersion: 7,
    });
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'moderation.apply-account-action',
      requiredPermission: 'ban_user',
      targetType: 'user',
      targetId: facts.targetUserId,
      expectedTargetVersion: 7,
      sourceReportId: facts.reportId,
    });
    get.mockResolvedValueOnce({ ...facts, assignedAdminId: randomUUID() });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      handler.execute({ ...query, expectedReviewVersion: 1 }, actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(issue).toHaveBeenCalledOnce();
  });
});
