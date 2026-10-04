import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import {
  PrepareAppealReviewAccessHandler,
  type AppealActionPreparationStore,
} from './prepare-appeal-review-access.js';
describe('current-ban appeal review preparation', () => {
  it('denies historical bans, terminal decisions and stale versions before granting review authority', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID();
    const authorize = vi.fn<AdminActionAuthorizationService['authorize']>(() =>
      Promise.resolve({
        adminUserId,
        actorUserId: actor.userId,
        commandCode: 'moderation.appeal-metadata',
        requiredPermission: 'review_appeals',
        targetType: 'appeal_queue',
        targetId: null,
        expectedTargetVersion: null,
      }),
    );
    const issue = vi.fn<AdminActionAuthorizationService['issue']>(() =>
      Promise.resolve('review-token'),
    );
    const facts = { appealVersion: 1, status: 'submitted', currentBan: true, accountVersion: 4 };
    const get = vi.fn<AppealActionPreparationStore['get']>(() => Promise.resolve(facts));
    const handler = new PrepareAppealReviewAccessHandler(
      { authorize, issue },
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }) },
      { get },
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: 'queue-token',
      appealId: randomUUID(),
      expectedAppealVersion: 1,
    };
    get.mockResolvedValueOnce({ ...facts, currentBan: false });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'conflict' });
    get.mockResolvedValueOnce({ ...facts, status: 'accepted' });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      handler.execute({ ...query, expectedAppealVersion: 2 }, actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(issue).not.toHaveBeenCalled();
    expect(await handler.execute(query, actor)).toEqual({
      adminActionToken: 'review-token',
      appealVersion: 1,
    });
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'moderation.review-appeal',
      requiredPermission: 'review_appeals',
      targetType: 'user_appeal',
      targetId: query.appealId,
      expectedTargetVersion: 1,
    });
  });
});
