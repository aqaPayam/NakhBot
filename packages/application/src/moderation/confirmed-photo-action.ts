import type { ApplyPhotoModerationActionCommand } from '@nakh/contracts';
import { requiredPermissionForModerationAction, type Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { PhotoModerationResult, PhotoModerationWorkflow } from './photo-action.js';
export type PhotoActionDraft = ConfirmableDraft<ApplyPhotoModerationActionCommand>;
function scope(command: PhotoActionDraft): ConfirmationScope {
  return {
    permission: requiredPermissionForModerationAction(command.data.action),
    targetType: 'photo',
    payload: [command.data.action],
  };
}
export class ConfirmedPhotoActions {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<PhotoModerationWorkflow<never>, 'apply'>,
  ) {}
  public prepare(command: PhotoActionDraft, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, scope(command));
  }
  public async execute(
    command: ApplyPhotoModerationActionCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<PhotoModerationResult>> {
    const { attempt } = await this.boundary.resolve(command, actor, scope(command));
    return this.workflow.apply(attempt, command.data.action);
  }
}
