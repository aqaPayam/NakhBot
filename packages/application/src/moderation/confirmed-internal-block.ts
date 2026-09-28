import type { ChangeInternalBlockCommand } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { InternalBlockResult, InternalBlockWorkflow } from './internal-block.js';
export type InternalBlockDraft = ConfirmableDraft<ChangeInternalBlockCommand>;
function scope(command: InternalBlockDraft): ConfirmationScope {
  return {
    permission: 'manage_internal_blocks',
    targetType: 'user_pair',
    payload: [command.data.action],
  };
}
export class ConfirmedInternalBlocks {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<InternalBlockWorkflow<never>, 'change'>,
  ) {}
  public prepare(command: InternalBlockDraft, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, scope(command));
  }
  public async execute(
    command: ChangeInternalBlockCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<InternalBlockResult>> {
    const { attempt } = await this.boundary.resolve(command, actor, scope(command));
    return this.workflow.change(attempt, command.data.action);
  }
}
