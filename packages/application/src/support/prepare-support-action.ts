import type { PrepareSupportActionQuery, PreparedSupportAction } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from '../moderation/queue-actions.js';
export interface SupportActionPreparationStore {
  get(threadId: string): Promise<Readonly<{ version: number; status: string }> | undefined>;
}
export class PrepareSupportActionHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly threads: SupportActionPreparationStore,
  ) {}
  public async execute(
    query: PrepareSupportActionQuery,
    actor: Actor,
  ): Promise<PreparedSupportAction> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      query.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const root = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'support.thread-metadata',
      requiredPermission: 'review_support',
      targetType: 'support_queue',
    });
    if (
      root.targetId !== null ||
      root.expectedTargetVersion !== null ||
      !['reply', 'close'].includes(query.action)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const thread = await this.threads.get(query.threadId);
    if (thread === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (thread.version !== query.expectedThreadVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (thread.status !== 'open')
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: query.action === 'reply' ? 'support.reply-thread' : 'support.close-thread',
        requiredPermission: 'review_support',
        targetType: 'support_thread',
        targetId: query.threadId,
        expectedTargetVersion: thread.version,
      },
    });
    return { adminActionToken, threadVersion: thread.version };
  }
}
