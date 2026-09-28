import { describe, expect, it } from 'vitest';

import type { IdGenerator } from '@nakh/domain';

import { canonicalAdminPairTargetId } from '../administration/admin-authorization.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import {
  InternalBlockWorkflow,
  type InternalBlockWorkflowStore,
  type InternalBlockWrite,
} from './internal-block.js';

const userLowId = '10000000-0000-7000-8000-000000000001';
const userHighId = '10000000-0000-7000-8000-000000000002';
const pair = { userLowId, userHighId } as const;
const pairTargetId = canonicalAdminPairTargetId(pair);

function attempt(overrides: Partial<AdminCommandAttempt> = {}): AdminCommandAttempt {
  return {
    logId: '20000000-0000-7000-8000-000000000001',
    adminUserId: '20000000-0000-7000-8000-000000000002',
    commandId: '20000000-0000-7000-8000-000000000003',
    requestId: '20000000-0000-7000-8000-000000000004',
    requestDigest: 'a'.repeat(64),
    commandCode: 'moderation.change-internal-block',
    requiredPermission: 'manage_internal_blocks',
    targetType: 'user_pair',
    targetId: pairTargetId,
    targetPair: pair,
    expectedTargetVersion: 3,
    reasonDigest: 'b'.repeat(64),
    metadata: {},
    correlationId: '20000000-0000-7000-8000-000000000005',
    ...overrides,
  };
}

class SequentialIds implements IdGenerator {
  private value = 10;
  public uuid(): string {
    this.value += 1;
    return `30000000-0000-7000-8000-${String(this.value).padStart(12, '0')}`;
  }
}

describe('internal block workflow', () => {
  it('binds the normalized pair and all durable fact identifiers into one admin transaction', async () => {
    let observed: InternalBlockWrite | undefined;
    const commands: AdminCommandExecutionStore<string> = {
      execute: async (commandAttempt, effect) => {
        const outcome = await effect('transaction');
        return {
          logId: commandAttempt.logId,
          result: 'succeeded',
          safeCode: outcome.safeCode,
          recordedAt: new Date(0),
          replayed: false,
          value: outcome.value,
        };
      },
      recordEvidenceAccess: () => Promise.reject(new Error('not used')),
    };
    const blocks: InternalBlockWorkflowStore<string> = {
      change: (context, write) => {
        expect(context).toBe('transaction');
        observed = write;
        return Promise.resolve({
          actionId: write.actionId,
          userLowId: write.userLowId,
          userHighId: write.userHighId,
          previousState: 'matched',
          nextState: 'blocked',
          pairVersion: 4,
          closedMatchId: null,
          closedChatSessionId: null,
          closedLikeCount: 0,
          revokedUnlockCount: 0,
        });
      },
    };
    const result = await new InternalBlockWorkflow(commands, blocks, new SequentialIds()).change(
      attempt(),
      'create',
    );

    expect(result.safeCode).toBe('internal_block_created');
    expect(observed).toMatchObject({
      action: 'create',
      pairTargetId,
      userLowId,
      userHighId,
      expectedPairVersion: 3,
    });
    expect(
      new Set([
        observed!.actionId,
        observed!.auditId,
        observed!.blockEventId,
        observed!.actionEventId,
      ]).size,
    ).toBe(4);
  });

  it('rejects an unbound, reversed, or wrongly authorized target before allocating effects', () => {
    let allocations = 0;
    const ids: IdGenerator = {
      uuid: () => {
        allocations += 1;
        return '30000000-0000-7000-8000-000000000001';
      },
    };
    const commands = {} as AdminCommandExecutionStore<unknown>;
    const blocks = {} as InternalBlockWorkflowStore<unknown>;
    const workflow = new InternalBlockWorkflow(commands, blocks, ids);
    const { targetPair: ignoredPair, ...unbound } = attempt();
    expect(ignoredPair).toEqual(pair);

    expect(() => workflow.change(unbound, 'create')).toThrow();
    expect(() =>
      workflow.change(
        attempt({ targetPair: { userLowId: userHighId, userHighId: userLowId } }),
        'create',
      ),
    ).toThrow();
    expect(() => workflow.change(attempt({ requiredPermission: 'ban_user' }), 'create')).toThrow();
    expect(() => workflow.change(attempt({ expectedTargetVersion: null }), 'remove')).toThrow();
    expect(allocations).toBe(0);
  });
});
