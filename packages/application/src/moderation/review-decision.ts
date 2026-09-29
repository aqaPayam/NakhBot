import { createHash } from 'node:crypto';
import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import type { ProtectedReviewNote, ReviewNoteProtector } from './review-note.js';

export type ReviewDecision = 'dismissed' | 'actioned';
export type ReviewDecisionResult = Readonly<{
  reviewId: string;
  reportId: string;
  status: ReviewDecision;
  version: number;
}>;
export type ReviewDecisionWrite = Readonly<{
  attempt: AdminCommandAttempt;
  decision: ReviewDecision;
  note: ProtectedReviewNote | undefined;
  auditId: string;
  eventId: string;
  actionId: string;
}>;
export interface ReviewDecisionStore<TContext> {
  decide(context: TContext, write: ReviewDecisionWrite): Promise<ReviewDecisionResult>;
}
export class ReviewDecisionWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly reviews: ReviewDecisionStore<TContext>,
    private readonly notes: ReviewNoteProtector,
    private readonly ids: IdGenerator,
  ) {}
  public decide(
    attempt: AdminCommandAttempt,
    decision: ReviewDecision,
    note?: string,
  ): Promise<AdminCommandExecutionResult<ReviewDecisionResult>> {
    const bound = {
      ...attempt,
      metadata: {},
      requestDigest: createHash('sha256')
        .update(JSON.stringify([attempt.requestDigest, decision, note ?? null]))
        .digest('hex'),
    };
    let protectedNote: ProtectedReviewNote | undefined;
    let preparationError: Error | undefined;
    try {
      protectedNote = this.notes.protect(attempt.targetId, note);
    } catch (error) {
      preparationError =
        error instanceof ApplicationError
          ? error
          : new Error('Review note encryption unavailable.');
    }
    return this.commands.execute(bound, async (context) => {
      if (
        attempt.commandCode !== 'moderation.decide-review' ||
        attempt.targetType !== 'moderation_review' ||
        attempt.expectedTargetVersion === null ||
        (decision !== 'dismissed' && decision !== 'actioned') ||
        attempt.requiredPermission !==
          (decision === 'dismissed' ? 'dismiss_report' : 'view_reports')
      )
        throw new ApplicationError(
          'invalid_request',
          'error.moderation.review_request_invalid',
          400,
        );
      if (preparationError !== undefined) throw preparationError;
      return {
        value: await this.reviews.decide(context, {
          attempt: bound,
          decision,
          note: protectedNote,
          auditId: this.ids.uuid(),
          eventId: this.ids.uuid(),
          actionId: this.ids.uuid(),
        }),
        safeCode: `review_${decision}`,
      };
    });
  }
}
