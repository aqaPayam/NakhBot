import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AdminActionAuthorizationService,
  AdminAuthorizationStore,
} from '../administration/admin-authorization.js';
import type { SelectAccountReturnApprovalQuery } from '@nakh/contracts';
import {
  SelectAccountReturnApprovalHandler,
  type AccountReturnApprovalSelectionStore,
} from './confirmed-account-return-approval.js';

function fixture(): {
  actor: { kind: 'admin'; userId: string };
  adminId: string;
  rootId: string;
  facts: {
    loadCurrent: Mock<AdminAuthorizationStore['loadCurrent']>;
    loadByTelegramIdentity: Mock<AdminAuthorizationStore['loadByTelegramIdentity']>;
  };
  identities: { get: Mock<() => Promise<{ adminUserId: string; telegramUserId: string }>> };
  roots: { get: Mock<AccountReturnApprovalSelectionStore['get']> };
  authorization: {
    issue: Mock<AdminActionAuthorizationService['issue']>;
    authorize: Mock<AdminActionAuthorizationService['authorize']>;
  };
  query: SelectAccountReturnApprovalQuery;
  handler: SelectAccountReturnApprovalHandler;
} {
  const actor = { kind: 'admin' as const, userId: randomUUID() },
    adminId = randomUUID(),
    rootId = randomUUID();
  const facts = {
    loadCurrent: vi.fn<AdminAuthorizationStore['loadCurrent']>(() =>
      Promise.resolve({
        adminUserId: adminId,
        actorUserId: actor.userId,
        adminActive: true,
        activePermissions: ['approve_account_return'],
      }),
    ),
    loadByTelegramIdentity: vi.fn<AdminAuthorizationStore['loadByTelegramIdentity']>(),
  };
  const identities = {
    get: vi.fn(() => Promise.resolve({ adminUserId: adminId, telegramUserId: '1234567' })),
  };
  const roots = {
    get: vi.fn<AccountReturnApprovalSelectionStore['get']>(() =>
      Promise.resolve({ version: 2, reviewable: true }),
    ),
  };
  const authorization = {
    issue: vi.fn<AdminActionAuthorizationService['issue']>(() => Promise.resolve('opaque-action')),
    authorize: vi.fn<AdminActionAuthorizationService['authorize']>(() =>
      Promise.resolve({
        adminUserId: adminId,
        actorUserId: actor.userId,
        commandCode: 'account.approve-return',
        requiredPermission: 'approve_account_return',
        targetType: 'account_deletion',
        targetId: rootId,
        expectedTargetVersion: 2,
      }),
    ),
  };
  return {
    actor,
    adminId,
    rootId,
    facts,
    identities,
    roots,
    authorization,
    query: { actor, requestId: randomUUID(), deletionRecordId: rootId, expectedTargetVersion: 2 },
    handler: new SelectAccountReturnApprovalHandler(identities, facts, authorization, roots),
  };
}
describe('administrator original-Root selection', () => {
  it('checks exact current permission before reading a Root and withholds stale preparations', async () => {
    const f = fixture();
    f.facts.loadCurrent.mockResolvedValue({
      adminUserId: f.adminId,
      actorUserId: f.actor.userId,
      adminActive: true,
      activePermissions: [],
    });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toThrow();
    expect(f.roots.get).not.toHaveBeenCalled();
    expect(f.authorization.issue).not.toHaveBeenCalled();
    f.facts.loadCurrent.mockResolvedValue({
      adminUserId: f.adminId,
      actorUserId: f.actor.userId,
      adminActive: true,
      activePermissions: ['approve_account_return'],
    });
    f.roots.get
      .mockResolvedValueOnce({ version: 2, reviewable: true })
      .mockResolvedValueOnce({ version: 2, reviewable: false });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toThrow();
    expect(f.authorization.authorize).not.toHaveBeenCalled();
  });
  it('captures actor, Root and expected version before awaits and rechecks authority after the last Root read', async () => {
    const f = fixture(),
      userId = f.actor.userId;
    const original = {
      adminUserId: f.adminId,
      actorUserId: userId,
      adminActive: true,
      activePermissions: ['approve_account_return'] as const,
    };
    f.facts.loadCurrent.mockResolvedValue(original);
    f.roots.get.mockImplementationOnce(() => {
      f.query.deletionRecordId = randomUUID();
      f.query.expectedTargetVersion = 99;
      f.actor.userId = randomUUID();
      return Promise.resolve({ version: 2, reviewable: true });
    });
    expect(await f.handler.execute(f.query, f.actor)).toEqual({
      adminActionToken: 'opaque-action',
      expectedTargetVersion: 2,
    });
    expect(f.roots.get.mock.calls).toEqual([[f.rootId], [f.rootId]]);
    expect(f.authorization.issue.mock.calls[0]![0]).toMatchObject({ actorUserId: userId });
    expect(f.authorization.issue.mock.calls[0]![0].scope).toEqual({
      commandCode: 'account.approve-return',
      requiredPermission: 'approve_account_return',
      targetType: 'account_deletion',
      targetId: f.rootId,
      expectedTargetVersion: 2,
    });
    expect(f.authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: 'admin', userId } }),
    );
    expect(f.authorization.authorize.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.roots.get.mock.invocationCallOrder[1]!,
    );
  });
});
