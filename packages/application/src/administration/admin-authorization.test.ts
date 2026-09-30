import { describe, expect, it } from 'vitest';

import type { M7Permission } from '@nakh/domain';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import {
  AdminActionAuthorizationService,
  canonicalAdminPairTargetId,
  type AdminAuthorizationFacts,
  type AdminAuthorizationStore,
  type AuthorizedAdminAction,
} from './admin-authorization.js';

const actorUserId = '10000000-0000-7000-8000-000000000001';
const otherUserId = '10000000-0000-7000-8000-000000000002';
const adminUserId = '20000000-0000-7000-8000-000000000001';
const targetId = '30000000-0000-7000-8000-000000000001';
const telegramUserId = '9000000001';
const key = Buffer.alloc(32, 7);

class MemoryTokens implements OpaqueTokenStore {
  public readonly values = new Map<string, string>();

  public putIfAbsent(id: string, value: string): Promise<boolean> {
    if (this.values.has(id)) return Promise.resolve(false);
    this.values.set(id, value);
    return Promise.resolve(true);
  }

  public get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(id));
  }
}

class Authorization implements AdminAuthorizationStore {
  public facts: AdminAuthorizationFacts | undefined = {
    adminUserId,
    actorUserId,
    adminActive: true,
    activePermissions: ['ban_user', 'view_reports'],
  };

  public loadByTelegramIdentity(input: {
    actorUserId: string;
    telegramUserId: string;
  }): Promise<AdminAuthorizationFacts | undefined> {
    return Promise.resolve(
      input.actorUserId === actorUserId && input.telegramUserId === telegramUserId
        ? this.facts
        : undefined,
    );
  }

  public loadCurrent(input: {
    adminUserId: string;
    actorUserId: string;
  }): Promise<AdminAuthorizationFacts | undefined> {
    return Promise.resolve(
      input.adminUserId === adminUserId && input.actorUserId === actorUserId
        ? this.facts
        : undefined,
    );
  }
}

function service(
  authorization = new Authorization(),
  tokens = new MemoryTokens(),
  now: () => number = () => 1_000_000,
): Readonly<{
  authorization: Authorization;
  tokens: MemoryTokens;
  service: AdminActionAuthorizationService;
}> {
  return {
    authorization,
    tokens,
    service: new AdminActionAuthorizationService(
      authorization,
      tokens,
      key,
      now,
      () => 'abcdefghijklmnop',
    ),
  };
}

const scope = {
  commandCode: 'moderation.apply-account-action',
  requiredPermission: 'ban_user' as const,
  targetType: 'user',
  targetId,
  expectedTargetVersion: 4,
};

describe('admin action authorization', () => {
  it('retains a report link only inside account action state and rejects unrelated scopes', async () => {
    const context = service();
    const sourceReportId = '40000000-0000-7000-8000-000000000001';
    const token = await context.service.issue({
      actorUserId,
      telegramUserId,
      scope: { ...scope, sourceReportId },
    });
    expect(token).not.toContain(sourceReportId);
    expect(
      await context.service.authorize({
        actor: { kind: 'admin', userId: actorUserId },
        token,
        commandCode: scope.commandCode,
        requiredPermission: scope.requiredPermission,
        targetType: scope.targetType,
      }),
    ).toMatchObject({ sourceReportId });
    await expect(
      context.service.issue({
        actorUserId,
        telegramUserId,
        scope: { ...scope, commandCode: 'moderation.assign-review', sourceReportId },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      context.service.issue({
        actorUserId,
        telegramUserId,
        scope: { ...scope, sourceReportId: 'bad' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('issues an opaque signed scope only for the verified Telegram-backed permission', async () => {
    const context = service();
    const token = await context.service.issue({ actorUserId, telegramUserId, scope });
    expect(token).toMatch(/^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(token).not.toContain(actorUserId);
    expect(token).not.toContain(telegramUserId);

    await expect(
      context.service.authorize({
        actor: { kind: 'admin', userId: actorUserId },
        token,
        commandCode: scope.commandCode,
        requiredPermission: scope.requiredPermission,
        targetType: scope.targetType,
      }),
    ).resolves.toEqual({ adminUserId, actorUserId, ...scope });
  });

  it('rejects forged provider identity, token signatures, actors, commands, and permission scope', async () => {
    const context = service();
    await expect(
      context.service.issue({ actorUserId, telegramUserId: '9000000002', scope }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const token = await context.service.issue({ actorUserId, telegramUserId, scope });
    const authorize = (overrides: {
      token?: string;
      actorUserId?: string;
      commandCode?: string;
      permission?: M7Permission;
      targetType?: string;
    }): Promise<AuthorizedAdminAction> =>
      context.service.authorize({
        actor: { kind: 'admin', userId: overrides.actorUserId ?? actorUserId },
        token: overrides.token ?? token,
        commandCode: overrides.commandCode ?? scope.commandCode,
        requiredPermission: overrides.permission ?? scope.requiredPermission,
        targetType: overrides.targetType ?? scope.targetType,
      });
    const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await expect(authorize({ token: forged })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(authorize({ actorUserId: otherUserId })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(authorize({ commandCode: 'moderation.reveal-evidence' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(authorize({ permission: 'view_reports' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(authorize({ targetType: 'photo' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechecks current PostgreSQL-style grants so disablement and role revocation are immediate', async () => {
    const context = service();
    const token = await context.service.issue({ actorUserId, telegramUserId, scope });
    context.authorization.facts = {
      adminUserId,
      actorUserId,
      adminActive: true,
      activePermissions: ['view_reports'],
    };
    await expect(
      context.service.authorize({
        actor: { kind: 'admin', userId: actorUserId },
        token,
        commandCode: scope.commandCode,
        requiredPermission: scope.requiredPermission,
        targetType: scope.targetType,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    context.authorization.facts = {
      adminUserId,
      actorUserId,
      adminActive: false,
      activePermissions: ['ban_user'],
    };
    await expect(
      context.service.authorize({
        actor: { kind: 'admin', userId: actorUserId },
        token,
        commandCode: scope.commandCode,
        requiredPermission: scope.requiredPermission,
        targetType: scope.targetType,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('fails closed for expired or malformed stored state and invalid issue scope', async () => {
    let now = 1_000_000;
    const context = service(new Authorization(), new MemoryTokens(), () => now);
    const token = await context.service.issue({
      actorUserId,
      telegramUserId,
      scope,
      ttlSeconds: 30,
    });
    now += 30_000;
    await expect(
      context.service.authorize({
        actor: { kind: 'admin', userId: actorUserId },
        token,
        commandCode: scope.commandCode,
        requiredPermission: scope.requiredPermission,
        targetType: scope.targetType,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      context.service.issue({
        actorUserId,
        telegramUserId,
        scope: { ...scope, expectedTargetVersion: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('binds both normalized users into an opaque pair-action scope', async () => {
    const context = service();
    context.authorization.facts = {
      adminUserId,
      actorUserId,
      adminActive: true,
      activePermissions: ['manage_internal_blocks'],
    };
    const targetPair = {
      userLowId: actorUserId,
      userHighId: otherUserId,
    } as const;
    const pairScope = {
      commandCode: 'moderation.change-internal-block',
      requiredPermission: 'manage_internal_blocks' as const,
      targetType: 'user_pair',
      targetId: canonicalAdminPairTargetId(targetPair),
      expectedTargetVersion: 1,
      targetPair,
    };
    const token = await context.service.issue({
      actorUserId,
      telegramUserId,
      scope: pairScope,
    });

    expect(context.tokens.values.get('abcdefghijklmnop')).not.toContain(token);
    await expect(
      context.service.authorize({
        actor: { kind: 'admin', userId: actorUserId },
        token,
        commandCode: pairScope.commandCode,
        requiredPermission: pairScope.requiredPermission,
        targetType: pairScope.targetType,
      }),
    ).resolves.toEqual({ adminUserId, actorUserId, ...pairScope });
    await expect(
      context.service.issue({
        actorUserId,
        telegramUserId,
        scope: { ...pairScope, targetPair: { userLowId: otherUserId, userHighId: targetId } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
