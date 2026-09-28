import {
  ApplicationError,
  normalizeUserPair,
  requiredPermissionForModerationAction,
  type IdGenerator,
  type UserPairState,
} from '@nakh/domain';

import { canonicalAdminPairTargetId } from '../administration/admin-authorization.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

export type InternalBlockAction = 'create' | 'remove';

export type InternalBlockResult = Readonly<{
  actionId: string;
  userLowId: string;
  userHighId: string;
  previousState: UserPairState | undefined;
  nextState: 'blocked' | undefined;
  pairVersion: number | null;
  closedMatchId: string | null;
  closedChatSessionId: string | null;
  closedLikeCount: number;
  revokedUnlockCount: number;
}>;

export type InternalBlockWrite = Readonly<{
  action: InternalBlockAction;
  adminUserId: string;
  pairTargetId: string;
  userLowId: string;
  userHighId: string;
  expectedPairVersion: number;
  requestId: string;
  commandId: string;
  requestDigest: string;
  actionId: string;
  auditId: string;
  blockEventId: string;
  actionEventId: string;
}>;

export interface InternalBlockWorkflowStore<TContext> {
  change(context: TContext, write: InternalBlockWrite): Promise<InternalBlockResult>;
}

function invalidRequest(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.moderation.pair_invalid', 400);
}

/** Coordinates a silent pair-safety transition inside the immutable admin-attempt transaction. */
export class InternalBlockWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly blocks: InternalBlockWorkflowStore<TContext>,
    private readonly ids: IdGenerator,
  ) {}

  public change(
    attempt: AdminCommandAttempt,
    action: InternalBlockAction,
  ): Promise<AdminCommandExecutionResult<InternalBlockResult>> {
    const pair = attempt.targetPair;
    const expectedVersion = attempt.expectedTargetVersion;
    if (
      attempt.commandCode !== 'moderation.change-internal-block' ||
      attempt.targetType !== 'user_pair' ||
      pair === undefined ||
      expectedVersion === null ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      (action !== 'create' && action !== 'remove') ||
      attempt.requiredPermission !==
        requiredPermissionForModerationAction(
          action === 'create' ? 'create_internal_block' : 'remove_internal_block',
        )
    )
      throw invalidRequest();

    const normalized = normalizeUserPair(pair.userLowId, pair.userHighId);
    if (
      normalized.userLowId !== pair.userLowId ||
      normalized.userHighId !== pair.userHighId ||
      canonicalAdminPairTargetId(normalized) !== attempt.targetId
    )
      throw invalidRequest();

    const write: InternalBlockWrite = {
      action,
      adminUserId: attempt.adminUserId,
      pairTargetId: attempt.targetId,
      userLowId: normalized.userLowId,
      userHighId: normalized.userHighId,
      expectedPairVersion: expectedVersion,
      requestId: attempt.requestId,
      commandId: attempt.commandId,
      requestDigest: attempt.requestDigest,
      actionId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      blockEventId: this.ids.uuid(),
      actionEventId: this.ids.uuid(),
    };
    return this.commands.execute(attempt, async (context) => ({
      value: await this.blocks.change(context, write),
      safeCode: `internal_block_${action}d`,
    }));
  }
}
