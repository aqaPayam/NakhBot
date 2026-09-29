import type { AssignModerationReviewCommand } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { AssignedModerationReview, ModerationReviewWorkflow } from './review.js';
export type ReviewAssignmentDraft = ConfirmableDraft<AssignModerationReviewCommand>;
function scope(command: ReviewAssignmentDraft): ConfirmationScope {
  return {
    permission: 'view_reports',
    targetType: 'moderation_review',
    payload: [command.data.assigneeAdminId],
  };
}
export class ConfirmedReviewAssignments {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<ModerationReviewWorkflow<never>, 'assign'>,
  ) {}
  public prepare(command: ReviewAssignmentDraft, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, scope(command));
  }
  public async execute(
    command: AssignModerationReviewCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<AssignedModerationReview>> {
    const { attempt } = await this.boundary.resolve(command, actor, scope(command));
    return this.workflow.assign(attempt, {
      reviewId: attempt.targetId,
      assigneeAdminId: command.data.assigneeAdminId,
      expectedVersion: command.data.expectedTargetVersion,
    });
  }
}
