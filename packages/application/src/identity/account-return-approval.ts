import type { IdGenerator } from '@nakh/domain';
import { ApplicationError } from '@nakh/domain';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

export type AccountReturnApproval = Readonly<{ approvalId: string; productEpoch: number }>;
export interface AccountReturnApprovalStore<TContext> {
  approve(
    context: TContext,
    attempt: AdminCommandAttempt,
    auditId: string,
  ): Promise<AccountReturnApproval>;
}

/** Trusted confirmed administrator attempt. Approval never executes Return. */
export class AccountReturnApprovalWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly approvals: AccountReturnApprovalStore<TContext>,
    private readonly ids: IdGenerator,
  ) {}

  public approve(
    attempt: AdminCommandAttempt,
  ): Promise<AdminCommandExecutionResult<AccountReturnApproval>> {
    if (
      attempt.commandCode !== 'account.approve-return' ||
      attempt.requiredPermission !== 'approve_account_return' ||
      attempt.targetType !== 'account_deletion' ||
      attempt.expectedTargetVersion === null
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const boundAttempt = Object.freeze({ ...attempt, metadata: {} });
    return this.commands.execute(boundAttempt, async (context) => ({
      value: await this.approvals.approve(context, boundAttempt, this.ids.uuid()),
      safeCode: 'return_approved',
    }));
  }
}
