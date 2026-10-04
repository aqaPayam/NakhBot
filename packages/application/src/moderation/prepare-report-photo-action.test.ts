import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import {
  PrepareReportPhotoActionHandler,
  type ReportPhotoActionPreparationStore,
} from './prepare-report-photo-action.js';
describe('report-bound photo action preparation', () => {
  it('issues authority only for the selected reported photo and rejects stale, missing or borrowed evidence', async () => {
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
      Promise.resolve('photo-token'),
    );
    const facts = {
      reviewVersion: 2,
      reviewStatus: 'in_review',
      assignedAdminId: adminUserId,
      reportId: randomUUID(),
      reportStatus: 'pending_review',
      photoId: randomUUID(),
      photoVersion: 5,
    };
    const get = vi.fn<ReportPhotoActionPreparationStore['get']>(() => Promise.resolve(facts));
    const handler = new PrepareReportPhotoActionHandler(
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
      evidenceId: randomUUID(),
      action: 'hide_photo' as const,
    };
    expect(await handler.execute(query, actor)).toEqual({
      adminActionToken: 'photo-token',
      photoVersion: 5,
    });
    expect(get).toHaveBeenCalledWith(query.reviewId, query.evidenceId);
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'moderation.apply-photo-action',
      requiredPermission: 'hide_photo',
      targetType: 'photo',
      targetId: facts.photoId,
      expectedTargetVersion: 5,
      sourceReportId: facts.reportId,
    });
    get.mockResolvedValueOnce(undefined);
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'not_found' });
    get.mockResolvedValueOnce({ ...facts, assignedAdminId: randomUUID() });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      handler.execute({ ...query, expectedReviewVersion: 1 }, actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(issue).toHaveBeenCalledOnce();
  });
});
