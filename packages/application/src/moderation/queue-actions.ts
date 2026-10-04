import type { AdminReportQueueActions, GetAdminReportQueueActionsQuery } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
export interface AdminQueueIdentityStore {
  get(
    actorUserId: string,
  ): Promise<Readonly<{ adminUserId: string; telegramUserId: string }> | undefined>;
}
/** Fixed scopes only: the caller cannot select another admin, target, version or permission. */
export class GetAdminReportQueueActionsHandler {
  public constructor(
    private readonly identities: AdminQueueIdentityStore,
    private readonly authorization: Pick<AdminActionAuthorizationService, 'issue'>,
  ) {}
  public async execute(
    query: GetAdminReportQueueActionsQuery,
    actor: Actor,
  ): Promise<AdminReportQueueActions> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      query.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const subject = { actorUserId: actor.userId, telegramUserId: identity.telegramUserId };
    const metadataActionToken = await this.authorization.issue({
      ...subject,
      scope: {
        commandCode: 'moderation.report-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report_queue',
        targetId: null,
        expectedTargetVersion: null,
      },
    });
    const claimActionToken = await this.authorization.issue({
      ...subject,
      scope: {
        commandCode: 'moderation.claim-reviews',
        requiredPermission: 'view_reports',
        targetType: 'admin_user',
        targetId: identity.adminUserId,
        expectedTargetVersion: null,
      },
    });
    return { metadataActionToken, claimActionToken };
  }
}
