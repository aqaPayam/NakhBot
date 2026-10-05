import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUserPair } from '@nakh/domain';
import {
  canonicalAdminPairTargetId,
  type AdminActionAuthorizationService,
} from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
import {
  PrepareSelectedReportInternalBlockHandler,
  type SelectedReportInternalBlockStore,
} from './prepare-selected-report-internal-block.js';
function fixture(): {
  actor: { kind: 'admin'; userId: string };
  adminId: string;
  query: Parameters<PrepareSelectedReportInternalBlockHandler['execute']>[0];
  facts: NonNullable<Awaited<ReturnType<SelectedReportInternalBlockStore['get']>>>;
  authorize: ReturnType<typeof vi.fn<AdminActionAuthorizationService['authorize']>>;
  issue: ReturnType<typeof vi.fn<AdminActionAuthorizationService['issue']>>;
  identity: ReturnType<typeof vi.fn<AdminQueueIdentityStore['get']>>;
  get: ReturnType<typeof vi.fn<SelectedReportInternalBlockStore['get']>>;
  handler: PrepareSelectedReportInternalBlockHandler;
} {
  const actor = { kind: 'admin' as const, userId: randomUUID() },
    adminId = randomUUID();
  const facts = {
    reportVersion: 2,
    reportStatus: 'pending_review',
    reporterUserId: randomUUID(),
    targetUserId: randomUUID(),
    pairVersion: 4,
    pairState: 'matched' as const,
  };
  const authorize = vi.fn<AdminActionAuthorizationService['authorize']>().mockResolvedValue({
    adminUserId: adminId,
    actorUserId: actor.userId,
    commandCode: 'moderation.report-metadata',
    requiredPermission: 'view_reports',
    targetType: 'report_queue',
    targetId: null,
    expectedTargetVersion: null,
  });
  const issue = vi.fn<AdminActionAuthorizationService['issue']>().mockResolvedValue('native-token');
  const identity = vi
    .fn<AdminQueueIdentityStore['get']>()
    .mockResolvedValue({ adminUserId: adminId, telegramUserId: '123' });
  const get = vi.fn<SelectedReportInternalBlockStore['get']>().mockResolvedValue(facts);
  const query = {
    actor,
    requestId: randomUUID(),
    adminActionToken: 'queue-token',
    reportId: randomUUID(),
    expectedReportVersion: 2,
    action: 'create' as const,
  };
  return {
    actor,
    adminId,
    facts,
    authorize,
    issue,
    identity,
    get,
    query,
    handler: new PrepareSelectedReportInternalBlockHandler(
      { authorize, issue },
      { get: identity },
      { get },
    ),
  };
}
describe('exact Report-derived internal block authority', () => {
  it('normalizes only the stored pair and returns opaque native authority without restricted identities', async () => {
    const f = fixture();
    const pair = normalizeUserPair(f.facts.reporterUserId, f.facts.targetUserId);
    expect(
      await f.handler.execute(
        {
          ...f.query,
          ...{
            userLowId: randomUUID(),
            userHighId: randomUUID(),
            expectedPairVersion: 999,
            sourceReportId: randomUUID(),
          },
        },
        f.actor,
      ),
    ).toEqual({ adminActionToken: 'native-token', pairVersion: 4 });
    expect(f.issue).toHaveBeenCalledWith({
      actorUserId: f.actor.userId,
      telegramUserId: '123',
      scope: {
        commandCode: 'moderation.change-internal-block',
        requiredPermission: 'manage_internal_blocks',
        targetType: 'user_pair',
        targetId: canonicalAdminPairTargetId(pair),
        targetPair: pair,
        expectedTargetVersion: 4,
        sourceReportId: f.query.reportId,
      },
    });
    expect(f.authorize).toHaveBeenLastCalledWith({
      actor: f.actor,
      token: 'native-token',
      commandCode: 'moderation.change-internal-block',
      requiredPermission: 'manage_internal_blocks',
      targetType: 'user_pair',
    });
  });
  it('permits terminal Report context and uses the native transition policy for create/removal', async () => {
    const f = fixture();
    for (const status of ['submitted', 'pending_review', 'dismissed', 'actioned', 'closed']) {
      f.get.mockResolvedValue({ ...f.facts, reportStatus: status, pairState: 'blocked' });
      await expect(
        f.handler.execute({ ...f.query, action: 'remove' }, f.actor),
      ).resolves.toMatchObject({ pairVersion: 4 });
      await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
        code: 'moderation_state_invalid',
      });
    }
    f.get.mockResolvedValue({ ...f.facts, pairState: undefined, pairVersion: 1 });
    await expect(f.handler.execute(f.query, f.actor)).resolves.toMatchObject({ pairVersion: 1 });
    await expect(
      f.handler.execute({ ...f.query, action: 'remove' }, f.actor),
    ).rejects.toMatchObject({ code: 'moderation_state_invalid' });
  });
  it('requires exact actor, root, identity, report version and specific permission before eligibility', async () => {
    const f = fixture();
    await expect(
      f.handler.execute(f.query, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.get).not.toHaveBeenCalled();
    const root = await f.authorize({
      actor: f.actor,
      token: 'queue-token',
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
    });
    f.authorize.mockResolvedValueOnce({ ...root, targetId: randomUUID() });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      f.handler.execute({ ...f.query, expectedReportVersion: 1 }, f.actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    f.identity.mockResolvedValueOnce(undefined);
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    f.get.mockResolvedValue({ ...f.facts, pairState: 'blocked' });
    f.issue.mockRejectedValueOnce(new Error('permission revoked'));
    await expect(f.handler.execute(f.query, f.actor)).rejects.toThrow('permission revoked');
  });
  it('rejects changes while grant issuance waits, then rechecks permission before returning a result', async () => {
    for (const changed of [
      { reportVersion: 3 },
      { reportStatus: 'closed' },
      { pairVersion: 5 },
      { pairState: 'blocked' as const },
      { reporterUserId: randomUUID() },
    ]) {
      const f = fixture();
      f.get.mockResolvedValueOnce(f.facts).mockResolvedValueOnce({ ...f.facts, ...changed });
      await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
        code: 'version_conflict',
      });
    }
    const f = fixture();
    const root = await f.authorize({
      actor: f.actor,
      token: '',
      commandCode: '',
      requiredPermission: 'view_reports',
      targetType: '',
    });
    f.authorize
      .mockResolvedValueOnce(root)
      .mockRejectedValueOnce(new Error('revoked before return'));
    await expect(f.handler.execute(f.query, f.actor)).rejects.toThrow('revoked before return');
    f.get.mockResolvedValueOnce(undefined);
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'not_found' });
  });
});
