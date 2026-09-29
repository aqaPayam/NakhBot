import type { DecideModerationReviewCommand } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { ReviewDecisionResult, ReviewDecisionWorkflow } from './review-decision.js';

export type ReviewDecisionDraft = ConfirmableDraft<DecideModerationReviewCommand>;
function scope(command: ReviewDecisionDraft): ConfirmationScope {
  return {
    permission: command.data.decision === 'dismissed' ? 'dismiss_report' : 'view_reports',
    targetType: 'moderation_review',
    payload: [command.data.decision, command.data.note ?? null],
  };
}
export class ConfirmedReviewDecisions {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<ReviewDecisionWorkflow<never>, 'decide'>,
  ) {}
  public prepare(command: ReviewDecisionDraft, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, scope(command));
  }
  public async execute(
    command: DecideModerationReviewCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<ReviewDecisionResult>> {
    const { attempt } = await this.boundary.resolve(command, actor, scope(command));
    return this.workflow.decide(attempt, command.data.decision, command.data.note);
  }
}
