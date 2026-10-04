import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import { PrepareSupportActionHandler } from './prepare-support-action.js';
describe('selected support action preparation', () => {
  it('allows a current closed thread only for reveal and grants no reply or stale authority', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID();
    const authorize = vi.fn<AdminActionAuthorizationService['authorize']>(() =>
      Promise.resolve({
        adminUserId,
        actorUserId: actor.userId,
        commandCode: 'support.thread-metadata',
        requiredPermission: 'review_support',
        targetType: 'support_queue',
        targetId: null,
        expectedTargetVersion: null,
      }),
    );
    const issue = vi.fn<AdminActionAuthorizationService['issue']>(() =>
      Promise.resolve('reveal-token'),
    );
    const handler = new PrepareSupportActionHandler(
      { authorize, issue },
      {
        get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }),
      },
      { get: () => Promise.resolve({ version: 3, status: 'closed' }) },
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: 'queue-token',
      threadId: randomUUID(),
      expectedThreadVersion: 3,
      action: 'reply' as const,
    };
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      handler.execute({ ...query, action: 'reveal', expectedThreadVersion: 2 }, actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(issue).not.toHaveBeenCalled();
    expect(await handler.execute({ ...query, action: 'reveal' }, actor)).toEqual({
      adminActionToken: 'reveal-token',
      threadVersion: 3,
    });
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'support.reveal-thread',
      requiredPermission: 'review_support',
      targetType: 'support_thread',
      targetId: query.threadId,
      expectedTargetVersion: 3,
    });
  });
});
