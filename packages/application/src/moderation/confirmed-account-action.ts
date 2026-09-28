import type { ApplyAccountModerationActionCommand } from '@nakh/contracts';
import { requiredPermissionForModerationAction, type Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { AccountModerationResult, AccountModerationWorkflow } from './account-action.js';
export type AccountActionDraft = ConfirmableDraft<ApplyAccountModerationActionCommand>;
function scope(command: AccountActionDraft): ConfirmationScope {
  return {
    permission: requiredPermissionForModerationAction(command.data.action),
    targetType: 'user',
    payload: [command.data.action],
  };
}
export class ConfirmedAccountActions {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<AccountModerationWorkflow<never>, 'apply'>,
  ) {}
  public prepare(command: AccountActionDraft, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, scope(command));
  }
  public async execute(
    command: ApplyAccountModerationActionCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<AccountModerationResult>> {
    const { attempt } = await this.boundary.resolve(command, actor, scope(command));
    return this.workflow.apply(attempt, command.data.action);
  }
}
