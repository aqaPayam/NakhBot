import { describe, expect, it } from 'vitest';

import type { IdGenerator } from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import {
  AccountModerationWorkflow,
  type AccountModerationWorkflowStore,
  type AccountModerationWrite,
} from './account-action.js';

const ids = [
  '10000000-0000-7000-8000-000000000001',
  '10000000-0000-7000-8000-000000000002',
  '10000000-0000-7000-8000-000000000003',
  '10000000-0000-7000-8000-000000000004',
  '10000000-0000-7000-8000-000000000005',
  '10000000-0000-7000-8000-000000000006',
  '10000000-0000-7000-8000-000000000007',
  '10000000-0000-7000-8000-000000000008',
];

function attempt(overrides: Partial<AdminCommandAttempt> = {}): AdminCommandAttempt {
  return {
    logId: '20000000-0000-7000-8000-000000000001',
    adminUserId: '20000000-0000-7000-8000-000000000002',
    commandId: '20000000-0000-7000-8000-000000000003',
    requestId: '20000000-0000-7000-8000-000000000004',
    requestDigest: 'a'.repeat(64),
    commandCode: 'moderation.apply-account-action',
    requiredPermission: 'ban_user',
    targetType: 'user',
    targetId: '20000000-0000-7000-8000-000000000005',
    expectedTargetVersion: 3,
    reasonDigest: 'b'.repeat(64),
    metadata: {},
    correlationId: '20000000-0000-7000-8000-000000000006',
    ...overrides,
  };
}

function fixture(): Readonly<{
  workflow: AccountModerationWorkflow<{ transaction: true }>;
  writes: AccountModerationWrite[];
}> {
  let index = 0;
  const generator: IdGenerator = { uuid: () => ids[index++]! };
  const writes: AccountModerationWrite[] = [];
  const accounts: AccountModerationWorkflowStore<{ transaction: true }> = {
    apply: (_context, write) => {
      writes.push(write);
      return Promise.resolve({
        actionId: write.actionId,
        targetUserId: write.targetUserId,
        previousState: 'active',
        nextState: 'banned',
        accountVersion: 4,
      });
    },
  };
  const commands: AdminCommandExecutionStore<{ transaction: true }> = {
    execute: async (commandAttempt, effect) => {
      const result = await effect({ transaction: true });
      return {
        logId: commandAttempt.logId,
        result: 'succeeded',
        safeCode: result.safeCode,
        recordedAt: new Date(0),
        replayed: false,
        value: result.value,
      };
    },
    recordEvidenceAccess: () => {
      throw new Error('not used');
    },
  };
  return { workflow: new AccountModerationWorkflow(commands, accounts, generator), writes };
}

describe('account moderation workflow', () => {
  it('binds exact permission, target version, request identity, and generated effect IDs', async () => {
    const context = fixture();
    const result = await context.workflow.apply(attempt(), 'ban_user');
    expect(result).toMatchObject({ result: 'succeeded', safeCode: 'account_ban_user' });
    expect(context.writes).toEqual([
      {
        action: 'ban_user',
        adminUserId: '20000000-0000-7000-8000-000000000002',
        targetUserId: '20000000-0000-7000-8000-000000000005',
        expectedAccountVersion: 3,
        requestId: '20000000-0000-7000-8000-000000000004',
        commandId: '20000000-0000-7000-8000-000000000003',
        requestDigest: 'a'.repeat(64),
        actionId: ids[0],
        auditId: ids[1],
        accountHistoryId: ids[2],
        notificationId: ids[3],
        notificationDeliveryId: ids[4],
        notificationDeliveryEventId: ids[5],
        accountEventId: ids[6],
        actionEventId: ids[7],
      },
    ]);
  });

  it('rejects mismatched action permission and unversioned or wrongly scoped commands', () => {
    const { workflow } = fixture();
    expect(() =>
      workflow.apply(attempt({ requiredPermission: 'restrict_user' }), 'ban_user'),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => workflow.apply(attempt({ expectedTargetVersion: null }), 'ban_user')).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => workflow.apply(attempt({ targetType: 'photo' }), 'ban_user')).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });
});
