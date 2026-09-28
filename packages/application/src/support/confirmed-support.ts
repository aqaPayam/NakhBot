import type { ReplySupportThreadCommand, CloseSupportThreadCommand } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { StoredSupportResult, SupportAdminWorkflow } from './support.js';
type Command = ReplySupportThreadCommand | CloseSupportThreadCommand;
export type SupportAdminDraft =
  ConfirmableDraft<ReplySupportThreadCommand> | ConfirmableDraft<CloseSupportThreadCommand>;
function scope(command: SupportAdminDraft): ConfirmationScope {
  return {
    permission: 'review_support',
    targetType: 'support_thread',
    payload: command.commandType === 'support.reply-thread' ? [command.data.text] : [],
  };
}
export class ConfirmedSupportCommands {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<SupportAdminWorkflow<never>, 'reply' | 'close'>,
  ) {}
  public prepare(command: SupportAdminDraft, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, scope(command));
  }
  public async execute(
    command: Command,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<StoredSupportResult>> {
    const { attempt } = await this.boundary.resolve(command, actor, scope(command));
    return command.commandType === 'support.reply-thread'
      ? this.workflow.reply(attempt, command.data.text)
      : this.workflow.close(attempt);
  }
}
