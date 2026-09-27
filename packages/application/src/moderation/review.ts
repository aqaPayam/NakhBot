import { ApplicationError } from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ClaimedModerationReview = Readonly<{
  reviewId: string;
  reportId: string;
  reviewVersion: number;
  priority: 'normal' | 'threshold';
}>;

export type AssignedModerationReview = Readonly<{
  reviewId: string;
  reportId: string;
  assignedAdminId: string;
  reviewVersion: number;
}>;

export interface ModerationReviewWorkflowStore<TContext> {
  claim(
    context: TContext,
    input: Readonly<{ adminUserId: string; limit: number }>,
  ): Promise<readonly ClaimedModerationReview[]>;
  assign(
    context: TContext,
    input: Readonly<{
      reviewId: string;
      assigneeAdminId: string;
      expectedVersion: number;
    }>,
  ): Promise<AssignedModerationReview>;
}

function invalidReviewRequest(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.moderation.review_request_invalid', 400);
}

/** Keeps review mutations inside the same audited admin-command transaction. */
export class ModerationReviewWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly reviews: ModerationReviewWorkflowStore<TContext>,
  ) {}

  public claim(
    attempt: AdminCommandAttempt,
    input: Readonly<{ limit: number }>,
  ): Promise<AdminCommandExecutionResult<readonly ClaimedModerationReview[]>> {
    if (
      attempt.commandCode !== 'moderation.claim-reviews' ||
      attempt.requiredPermission !== 'view_reports' ||
      attempt.targetType !== 'admin_user' ||
      attempt.targetId !== attempt.adminUserId ||
      attempt.expectedTargetVersion !== null ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw invalidReviewRequest();
    return this.commands.execute(attempt, async (context) => {
      const claimed = await this.reviews.claim(context, {
        adminUserId: attempt.adminUserId,
        limit: input.limit,
      });
      return {
        value: claimed,
        safeCode: claimed.length === 0 ? 'review_queue_empty' : 'reviews_claimed',
      };
    });
  }

  public assign(
    attempt: AdminCommandAttempt,
    input: Readonly<{ reviewId: string; assigneeAdminId: string; expectedVersion: number }>,
  ): Promise<AdminCommandExecutionResult<AssignedModerationReview>> {
    if (
      attempt.commandCode !== 'moderation.assign-review' ||
      attempt.requiredPermission !== 'view_reports' ||
      attempt.targetType !== 'moderation_review' ||
      attempt.targetId !== input.reviewId ||
      attempt.expectedTargetVersion !== input.expectedVersion ||
      !UUID.test(input.assigneeAdminId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    )
      throw invalidReviewRequest();
    return this.commands.execute(attempt, async (context) => ({
      value: await this.reviews.assign(context, input),
      safeCode: 'review_assigned',
    }));
  }
}
