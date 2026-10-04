import type { PrepareReviewActionQuery, PreparedReviewAction } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
export interface ReviewActionPreparationStore {
  get(reviewId: string): Promise<
    | Readonly<{
        version: number;
        status: string;
        assignedAdminId: string | null;
        reportStatus: string;
        hasModerationAction: boolean;
      }>
    | undefined
  >;
}
export class PrepareReviewActionHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reviews: ReviewActionPreparationStore,
  ) {}
  public async execute(
    query: PrepareReviewActionQuery,
    actor: Actor,
  ): Promise<PreparedReviewAction> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      query.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const root = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
    });
    if (root.targetId !== null || root.expectedTargetVersion !== null)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    if (!['assign', 'dismissed', 'actioned'].includes(query.action))
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const review = await this.reviews.get(query.reviewId);
    if (review === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (review.version !== query.expectedReviewVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (
      review.reportStatus !== 'pending_review' ||
      !['pending', 'in_review'].includes(review.status)
    )
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    if (
      query.action !== 'assign' &&
      (review.status !== 'in_review' || review.assignedAdminId !== root.adminUserId)
    )
      throw new ApplicationError('forbidden', 'error.moderation.reviewer_unauthorized', 403);
    if (query.action === 'actioned' && !review.hasModerationAction)
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode:
          query.action === 'assign' ? 'moderation.assign-review' : 'moderation.decide-review',
        requiredPermission: query.action === 'dismissed' ? 'dismiss_report' : 'view_reports',
        targetType: 'moderation_review',
        targetId: query.reviewId,
        expectedTargetVersion: review.version,
      },
    });
    return { adminActionToken, reviewVersion: review.version };
  }
}
