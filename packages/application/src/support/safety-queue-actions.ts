import type { GetSafetyQueueActionsQuery, SafetyQueueActions } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from '../moderation/queue-actions.js';
export class GetSafetyQueueActionsHandler {
  public constructor(
    private readonly identities: AdminQueueIdentityStore,
    private readonly authorization: Pick<AdminActionAuthorizationService, 'issue'>,
  ) {}
  public async execute(
    query: GetSafetyQueueActionsQuery,
    actor: Actor,
  ): Promise<SafetyQueueActions> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      query.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    if (query.queue !== 'support' && query.queue !== 'appeals')
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const support = query.queue === 'support';
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: support ? 'support.thread-metadata' : 'moderation.appeal-metadata',
        requiredPermission: support ? 'review_support' : 'review_appeals',
        targetType: support ? 'support_queue' : 'appeal_queue',
        targetId: null,
        expectedTargetVersion: null,
      },
    });
    return { adminActionToken };
  }
}
