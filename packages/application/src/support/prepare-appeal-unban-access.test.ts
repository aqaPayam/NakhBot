import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AppealActionPreparationStore } from './prepare-appeal-review-access.js';
import { PrepareAppealUnbanAccessHandler } from './prepare-appeal-unban-access.js';
describe('separate accepted-appeal unban preparation', () => {
  it('requires acceptance for the exact current ban and never substitutes review permission for unban', async () => {
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
      Promise.resolve('unban-token'),
    );
    const facts = { appealVersion: 2, status: 'accepted', currentBan: true, accountVersion: 4 };
    const get = vi.fn<AppealActionPreparationStore['get']>(() => Promise.resolve(facts));
    const handler = new PrepareAppealUnbanAccessHandler(
      { authorize, issue },
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }) },
      { get },
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: 'queue-token',
      appealId: randomUUID(),
      expectedAppealVersion: 2,
    };
    get.mockResolvedValueOnce({ ...facts, status: 'submitted' });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'conflict' });
    get.mockResolvedValueOnce({ ...facts, currentBan: false });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'conflict' });
    expect(issue).not.toHaveBeenCalled();
    expect(await handler.execute(query, actor)).toEqual({
      adminActionToken: 'unban-token',
      appealVersion: 2,
      accountVersion: 4,
    });
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'moderation.unban-appeal',
      requiredPermission: 'unban_user',
      targetType: 'user_appeal',
      targetId: query.appealId,
      expectedTargetVersion: 2,
    });
    issue.mockRejectedValueOnce(new ApplicationError('forbidden', 'error.admin.unauthorized', 403));
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
