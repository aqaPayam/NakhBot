import type {
  PrepareSelectedReportReviewQuery,
  PreparedSelectedReportReview,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
import type { PrepareReviewActionHandler } from './prepare-review-action.js';

export interface SelectedReportReviewStore {
  get(reportId: string): Promise<
    | Readonly<{
        reportVersion: number;
        reportStatus: string;
        reviewId: string;
        reviewVersion: number;
      }>
    | undefined
  >;
}

/** Queue-selected Report resolves to its governing review; assignee identity is never client data.
 * Preparation has no mutation or evidence access. Native confirmation/execution retains authority. */
export class PrepareSelectedReportReviewHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reports: SelectedReportReviewStore,
    private readonly actions: Pick<PrepareReviewActionHandler, 'execute'>,
  ) {}
  public async execute(
    query: PrepareSelectedReportReviewQuery,
    actor: Actor,
  ): Promise<PreparedSelectedReportReview> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      actor.userId !== query.actor.userId
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
      !Number.isSafeInteger(query.expectedReportVersion) ||
      query.expectedReportVersion < 1 ||
      !['assign', 'dismissed', 'actioned'].includes(query.action)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const report = await this.reports.get(query.reportId);
    if (report === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (report.reportVersion !== query.expectedReportVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (report.reportStatus !== 'pending_review')
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const prepared = await this.actions.execute(
      {
        actor: { kind: 'admin', userId: actor.userId },
        requestId: query.requestId,
        adminActionToken: query.adminActionToken,
        reviewId: report.reviewId,
        expectedReviewVersion: report.reviewVersion,
        action: query.action,
      },
      actor,
    );
    if (prepared.reviewVersion !== report.reviewVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    return { ...prepared, reviewId: report.reviewId, assigneeAdminId: identity.adminUserId };
  }
}
