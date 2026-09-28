import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdminConfirmationTokens } from './admin-confirmation.js';
import { ConfirmedAdminCommandBoundary, type AdminCommandDraft } from './confirmed-command.js';

describe('shared admin confirmation boundary', () => {
  it('binds payload, reason, actor, command and target version without storing restricted text', async () => {
    let now = 1000;
    const rows = new Map<string, string>();
    const tokens = {
      get: (id: string) => Promise.resolve(rows.get(id)),
      putIfAbsent: (id: string, value: string) => {
        if (rows.has(id)) return Promise.resolve(false);
        rows.set(id, value);
        return Promise.resolve(true);
      },
    };
    const actor = { kind: 'admin' as const, userId: randomUUID() };
    const action = {
      actorUserId: actor.userId,
      adminUserId: randomUUID(),
      commandCode: 'support.reply-thread',
      requiredPermission: 'review_support' as const,
      targetType: 'support_thread',
      targetId: randomUUID(),
      expectedTargetVersion: 1,
      expiresAt: 9999999,
    };
    const boundary = new ConfirmedAdminCommandBoundary(
      { authorize: () => Promise.resolve(action), resolveAttempt: () => Promise.resolve(action) },
      new AdminConfirmationTokens(tokens, Buffer.alloc(32, 7), () => now),
      { uuid: randomUUID },
      () => now,
    );
    const draft: AdminCommandDraft = {
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: action.commandCode,
      data: { adminActionToken: 'opaque', expectedTargetVersion: 1, reason: 'Restricted reason' },
    };
    const scope = {
      permission: 'review_support' as const,
      targetType: 'support_thread',
      payload: ['Restricted reply'],
    };
    const confirmationToken = await boundary.prepare(draft, actor, scope);
    const command = { ...draft, data: { ...draft.data, confirmationToken } };
    expect(
      (await boundary.resolve(command, actor, scope)).attempt.preconditionRejection,
    ).toBeUndefined();
    expect(
      (await boundary.resolve(command, actor, { ...scope, payload: ['Changed reply'] })).attempt
        .preconditionRejection,
    ).toBe('invalid_request');
    expect(
      (await boundary.resolve({ ...command, commandId: randomUUID() }, actor, scope)).attempt
        .preconditionRejection,
    ).toBe('invalid_request');
    expect(
      (
        await boundary.resolve(
          { ...command, data: { ...command.data, reason: 'Changed reason' } },
          actor,
          scope,
        )
      ).attempt.preconditionRejection,
    ).toBe('invalid_request');
    expect(
      (
        await boundary.resolve(
          { ...command, data: { ...command.data, expectedTargetVersion: 2 } },
          actor,
          scope,
        )
      ).attempt.preconditionRejection,
    ).toBe('version_conflict');
    await expect(
      boundary.resolve(command, { ...actor, userId: randomUUID() }, scope),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(JSON.stringify([...rows.values()])).not.toContain('Restricted');
    now += 300000;
    expect((await boundary.resolve(command, actor, scope)).attempt.preconditionRejection).toBe(
      'invalid_request',
    );
  });
});
