import {
  ApplicationError,
  requiredPermissionForModerationAction,
  type AccountState,
  type IdGenerator,
  type ModerationActionType,
} from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const accountActions = new Set<ModerationActionType>([
  'restrict_user',
  'unrestrict_user',
  'ban_user',
  'unban_user',
]);

export type AccountModerationAction = Extract<
  ModerationActionType,
  'restrict_user' | 'unrestrict_user' | 'ban_user' | 'unban_user'
>;

export type AccountModerationResult = Readonly<{
  actionId: string;
  targetUserId: string;
  previousState: AccountState;
  nextState: AccountState;
  accountVersion: number;
}>;

export type AccountModerationWrite = Readonly<{
  action: AccountModerationAction;
  adminUserId: string;
  targetUserId: string;
  expectedAccountVersion: number;
  requestId: string;
  commandId: string;
  requestDigest: string;
  actionId: string;
  auditId: string;
  accountHistoryId: string;
  notificationId: string;
  notificationDeliveryId: string;
  notificationDeliveryEventId: string;
  accountEventId: string;
  actionEventId: string;
}>;

export interface AccountModerationWorkflowStore<TContext> {
  apply(context: TContext, write: AccountModerationWrite): Promise<AccountModerationResult>;
}

function invalidRequest(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.moderation.account_action_invalid', 400);
}

/** Coordinates an authorized account action inside the immutable admin-attempt transaction. */
export class AccountModerationWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly accounts: AccountModerationWorkflowStore<TContext>,
    private readonly ids: IdGenerator,
  ) {}

  public apply(
    attempt: AdminCommandAttempt,
    action: AccountModerationAction,
  ): Promise<AdminCommandExecutionResult<AccountModerationResult>> {
    const expectedVersion = attempt.expectedTargetVersion;
    if (
      attempt.commandCode !== 'moderation.apply-account-action' ||
      attempt.targetType !== 'user' ||
      !UUID.test(attempt.targetId) ||
      expectedVersion === null ||
      !accountActions.has(action) ||
      attempt.requiredPermission !== requiredPermissionForModerationAction(action)
    )
      throw invalidRequest();

    const write: AccountModerationWrite = {
      action,
      adminUserId: attempt.adminUserId,
      targetUserId: attempt.targetId,
      expectedAccountVersion: expectedVersion,
      requestId: attempt.requestId,
      commandId: attempt.commandId,
      requestDigest: attempt.requestDigest,
      actionId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      accountHistoryId: this.ids.uuid(),
      notificationId: this.ids.uuid(),
      notificationDeliveryId: this.ids.uuid(),
      notificationDeliveryEventId: this.ids.uuid(),
      accountEventId: this.ids.uuid(),
      actionEventId: this.ids.uuid(),
    };
    return this.commands.execute(attempt, async (context) => ({
      value: await this.accounts.apply(context, write),
      safeCode: `account_${action}`,
    }));
  }
}
