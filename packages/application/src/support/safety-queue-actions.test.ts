import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import { GetSafetyQueueActionsHandler } from './safety-queue-actions.js';
describe('fixed safety queue access', () => {
  it('selects exact queue permissions from verified identity and allocates nothing for mismatched actors', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() };
    const issue = vi.fn<AdminActionAuthorizationService['issue']>(() =>
      Promise.resolve('queue-token'),
    );
    const get = vi.fn(() =>
      Promise.resolve({ adminUserId: randomUUID(), telegramUserId: '123456789' }),
    );
    const handler = new GetSafetyQueueActionsHandler({ get }, { issue });
    const query = { actor, requestId: randomUUID(), queue: 'support' as const };
    expect(await handler.execute(query, actor)).toEqual({ adminActionToken: 'queue-token' });
    expect(issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'support.thread-metadata',
      requiredPermission: 'review_support',
      targetType: 'support_queue',
      targetId: null,
      expectedTargetVersion: null,
    });
    await handler.execute({ ...query, queue: 'appeals' }, actor);
    expect(issue.mock.calls[1]![0].scope).toEqual({
      commandCode: 'moderation.appeal-metadata',
      requiredPermission: 'review_appeals',
      targetType: 'appeal_queue',
      targetId: null,
      expectedTargetVersion: null,
    });
    await expect(handler.execute(query, { ...actor, userId: randomUUID() })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(2);
  });
});
