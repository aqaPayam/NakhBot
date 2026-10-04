import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import { GetAdminReportQueueActionsHandler } from './queue-actions.js';
describe('fixed actor-bound report queue access', () => {
  it('issues only root metadata and own-admin claim scopes, and rejects identity substitution before lookup', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID();
    const get = vi.fn(() => Promise.resolve({ adminUserId, telegramUserId: '123456789' }));
    const issue = vi
      .fn<AdminActionAuthorizationService['issue']>()
      .mockResolvedValueOnce('metadata-token')
      .mockResolvedValueOnce('claim-token');
    const handler = new GetAdminReportQueueActionsHandler({ get }, { issue });
    const query = { actor, requestId: randomUUID() };
    expect(await handler.execute(query, actor)).toEqual({
      metadataActionToken: 'metadata-token',
      claimActionToken: 'claim-token',
    });
    expect(issue.mock.calls.map((call) => call[0].scope)).toEqual([
      {
        commandCode: 'moderation.report-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report_queue',
        targetId: null,
        expectedTargetVersion: null,
      },
      {
        commandCode: 'moderation.claim-reviews',
        requiredPermission: 'view_reports',
        targetType: 'admin_user',
        targetId: adminUserId,
        expectedTargetVersion: null,
      },
    ]);
    expect(
      issue.mock.calls.every(
        (call) => call[0].actorUserId === actor.userId && call[0].telegramUserId === '123456789',
      ),
    ).toBe(true);
    await expect(
      handler.execute(query, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(get).toHaveBeenCalledOnce();
    expect(issue).toHaveBeenCalledTimes(2);
  });
  it('does not allocate tokens for an unknown or disabled admin identity', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      issue = vi.fn<AdminActionAuthorizationService['issue']>();
    const handler = new GetAdminReportQueueActionsHandler(
      { get: () => Promise.resolve(undefined) },
      { issue },
    );
    await expect(handler.execute({ actor, requestId: randomUUID() }, actor)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
