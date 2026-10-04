import type { PrepareAppealReviewAccessQuery, PreparedAppealReviewAccess } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from '../moderation/queue-actions.js';
export interface AppealActionPreparationStore {
  get(appealId: string): Promise<
    | Readonly<{
        appealVersion: number;
        status: string;
        currentBan: boolean;
        accountVersion: number;
      }>
    | undefined
  >;
}
export class PrepareAppealReviewAccessHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly appeals: AppealActionPreparationStore,
  ) {}
  public async execute(
    query: PrepareAppealReviewAccessQuery,
    actor: Actor,
  ): Promise<PreparedAppealReviewAccess> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      query.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const root = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.appeal-metadata',
      requiredPermission: 'review_appeals',
      targetType: 'appeal_queue',
    });
    if (root.targetId !== null || root.expectedTargetVersion !== null)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const appeal = await this.appeals.get(query.appealId);
    if (appeal === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (appeal.appealVersion !== query.expectedAppealVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (!appeal.currentBan || !['submitted', 'in_review'].includes(appeal.status))
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'moderation.review-appeal',
        requiredPermission: 'review_appeals',
        targetType: 'user_appeal',
        targetId: query.appealId,
        expectedTargetVersion: appeal.appealVersion,
      },
    });
    return { adminActionToken, appealVersion: appeal.appealVersion };
  }
}
