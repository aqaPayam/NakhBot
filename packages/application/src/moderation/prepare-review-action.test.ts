import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import {
  PrepareReviewActionHandler,
  type ReviewActionPreparationStore,
} from './prepare-review-action.js';
describe('fixed review action preparation', () => {
  it('requires reviewer ownership and a linked moderation action before issuing decision authority', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID(),
      reviewId = randomUUID();
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
      Promise.resolve('review-token'),
    );
    const facts = {
      version: 2,
      status: 'in_review',
      assignedAdminId: adminUserId,
      reportStatus: 'pending_review',
      hasModerationAction: false,
    };
    const get = vi.fn<ReviewActionPreparationStore['get']>(() => Promise.resolve(facts));
    const handler = new PrepareReviewActionHandler(
      { authorize, issue },
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }) },
      { get },
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: 'queue-token',
      reviewId,
      expectedReviewVersion: 2,
      action: 'dismissed' as const,
    };
    await handler.execute(query, actor);
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'moderation.decide-review',
      requiredPermission: 'dismiss_report',
      targetType: 'moderation_review',
      targetId: reviewId,
      expectedTargetVersion: 2,
    });
    await expect(handler.execute({ ...query, action: 'actioned' }, actor)).rejects.toMatchObject({
      code: 'conflict',
    });
    get.mockResolvedValueOnce({ ...facts, assignedAdminId: randomUUID() });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      handler.execute({ ...query, expectedReviewVersion: 1 }, actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(issue).toHaveBeenCalledOnce();
    get.mockResolvedValueOnce({ ...facts, hasModerationAction: true });
    await handler.execute({ ...query, action: 'actioned' }, actor);
    expect(issue.mock.calls[1]![0].scope.requiredPermission).toBe('view_reports');
  });
});
