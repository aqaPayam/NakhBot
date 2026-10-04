import type { PrepareReportAccountActionQuery, PreparedReportAccountAction } from '@nakh/contracts';
import {
  ApplicationError,
  canApplyAccountModerationAction,
  type AccountState,
  type Actor,
} from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
export interface ReportAccountActionPreparationStore {
  get(reviewId: string): Promise<
    | Readonly<{
        reviewVersion: number;
        reviewStatus: string;
        assignedAdminId: string | null;
        reportId: string;
        reportStatus: string;
        targetUserId: string;
        accountVersion: number;
        accountState: AccountState;
      }>
    | undefined
  >;
}
/** The report's governing target and current Account version come exclusively from the server. */
export class PrepareReportAccountActionHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reports: ReportAccountActionPreparationStore,
  ) {}
  public async execute(
    query: PrepareReportAccountActionQuery,
    actor: Actor,
  ): Promise<PreparedReportAccountAction> {
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
    if (
      root.targetId !== null ||
      root.expectedTargetVersion !== null ||
      !['restrict_user', 'unrestrict_user', 'ban_user', 'unban_user'].includes(query.action)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const report = await this.reports.get(query.reviewId);
    if (report === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (report.reviewVersion !== query.expectedReviewVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (report.reviewStatus !== 'in_review' || report.reportStatus !== 'pending_review')
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    if (report.assignedAdminId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.moderation.reviewer_unauthorized', 403);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'moderation.apply-account-action',
        requiredPermission: query.action,
        targetType: 'user',
        targetId: report.targetUserId,
        expectedTargetVersion: report.accountVersion,
        sourceReportId: report.reportId,
      },
    });
    if (!canApplyAccountModerationAction(report.accountState, query.action))
      throw new ApplicationError(
        'moderation_state_invalid',
        'error.moderation.account_action_unavailable',
        409,
      );
    return { adminActionToken, accountVersion: report.accountVersion };
  }
}
