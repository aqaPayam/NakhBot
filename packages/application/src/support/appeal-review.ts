import { createHash } from 'node:crypto';

import type { AppealResult } from '@nakh/contracts';
import { ApplicationError, normalizeReviewNote, type IdGenerator } from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

export type AppealDecision = 'accepted' | 'rejected';
export type AppealReviewWrite = Readonly<{
  appealId: string;
  adminUserId: string;
  expectedVersion: number;
  decision: AppealDecision;
  normalizedNote?: string;
  auditId: string;
  eventId: string;
  requestId: string;
  commandId: string;
}>;

export interface AppealReviewStore<TContext> {
  review(context: TContext, write: AppealReviewWrite): Promise<AppealResult>;
}

/** Takes a trusted, confirmed admin attempt from the authorization boundary. */
export class AppealReviewWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly appeals: AppealReviewStore<TContext>,
    private readonly ids: IdGenerator,
  ) {}

  public review(
    attempt: AdminCommandAttempt,
    decision: AppealDecision,
    note?: string,
  ): Promise<AdminCommandExecutionResult<AppealResult>> {
    if (
      attempt.commandCode !== 'moderation.review-appeal' ||
      attempt.requiredPermission !== 'review_appeals' ||
      attempt.targetType !== 'user_appeal' ||
      attempt.expectedTargetVersion === null
    )
      throw new ApplicationError('invalid_request', 'error.appeal.review_invalid', 400);
    // Bind even invalid input before entering the audited boundary. Validation belongs in the
    // savepoint, so an invalid note is recorded as a rejection rather than an unlogged attempt.
    const boundAttempt = {
      ...attempt,
      metadata: {},
      requestDigest: createHash('sha256')
        .update(JSON.stringify([attempt.requestDigest, decision, note ?? null]))
        .digest('hex'),
    };
    return this.commands.execute(boundAttempt, async (context) => {
      if (decision !== 'accepted' && decision !== 'rejected')
        throw new ApplicationError('invalid_request', 'error.appeal.review_invalid', 400);
      const normalizedNote = normalizeReviewNote(note);
      return {
        value: await this.appeals.review(context, {
          appealId: attempt.targetId,
          adminUserId: attempt.adminUserId,
          expectedVersion: attempt.expectedTargetVersion!,
          decision,
          ...(normalizedNote === undefined ? {} : { normalizedNote }),
          auditId: this.ids.uuid(),
          eventId: this.ids.uuid(),
          requestId: attempt.requestId,
          commandId: attempt.commandId,
        }),
        safeCode: `appeal_${decision}`,
      };
    });
  }
}
