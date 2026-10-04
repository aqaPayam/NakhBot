import { createHash } from 'node:crypto';
import type { ClaimModerationReviewsCommand } from '@nakh/contracts';
import { ApplicationError, type Actor, type IdGenerator } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
} from '../administration/admin-command.js';
import type { ClaimedModerationReview, ModerationReviewWorkflow } from './review.js';

/** Queue ownership is scoped to the authenticated admin; it grants no evidence or moderation action. */
export class ClaimModerationReviewsHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'resolveAttempt'>,
    private readonly reviews: Pick<ModerationReviewWorkflow<never>, 'claim'>,
    private readonly ids: IdGenerator,
    private readonly now: () => number = Date.now,
  ) {}
  public async execute(
    command: ClaimModerationReviewsCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<readonly ClaimedModerationReview[]>> {
    if (
      actor.kind !== 'admin' ||
      command.actor.kind !== 'admin' ||
      command.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const action = await this.authorization.resolveAttempt({
      actor,
      token: command.data.adminActionToken,
      commandCode: 'moderation.claim-reviews',
      requiredPermission: 'view_reports',
      targetType: 'admin_user',
    });
    const invalid =
      command.commandType !== 'moderation.claim-reviews' ||
      command.schemaVersion !== 1 ||
      !Number.isSafeInteger(command.data.limit) ||
      command.data.limit < 1 ||
      command.data.limit > 50 ||
      action.targetId !== action.adminUserId ||
      action.expectedTargetVersion !== null ||
      action.expiresAt <= this.now();
    const attempt: AdminCommandAttempt = {
      logId: this.ids.uuid(),
      adminUserId: action.adminUserId,
      commandId: command.commandId,
      requestId: command.requestId,
      commandCode: 'moderation.claim-reviews',
      requiredPermission: 'view_reports',
      targetType: 'admin_user',
      targetId: action.adminUserId,
      expectedTargetVersion: null,
      reasonDigest: createHash('sha256').update('claim-own-moderation-queue').digest('hex'),
      metadata: {},
      correlationId: command.requestId,
      requestDigest: createHash('sha256')
        .update(
          JSON.stringify([
            'review-claim',
            1,
            actor.userId,
            command.commandId,
            command.data.adminActionToken,
            command.data.limit,
            action.adminUserId,
            action.targetId,
            action.expectedTargetVersion,
          ]),
        )
        .digest('hex'),
      ...(invalid ? { preconditionRejection: 'invalid_request' as const } : {}),
    };
    // A structurally invalid direct invocation still reaches the immutable rejection transaction.
    return this.reviews.claim(attempt, { limit: invalid ? 1 : command.data.limit });
  }
}
