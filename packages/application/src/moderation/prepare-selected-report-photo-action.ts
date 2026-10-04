import type {
  PrepareSelectedReportPhotoActionQuery,
  PreparedReportPhotoAction,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
import type { SelectedReportReviewStore } from './prepare-selected-report-review.js';
import type { PrepareReportPhotoActionHandler } from './prepare-report-photo-action.js';

/** Resolves queue-selected Report to the governing review and native photo authority.
 * No client photo/review identity, mutation or evidence access is accepted. */
export class PrepareSelectedReportPhotoActionHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reports: SelectedReportReviewStore,
    private readonly actions: Pick<PrepareReportPhotoActionHandler, 'execute'>,
  ) {}
  public async execute(
    query: PrepareSelectedReportPhotoActionQuery,
    actor: Actor,
  ): Promise<PreparedReportPhotoAction> {
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
      !['hide_photo', 'restore_photo', 'delete_photo'].includes(query.action)
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
        evidenceId: query.evidenceId,
      },
      actor,
    );
    const current = await this.reports.get(query.reportId);
    if (
      current === undefined ||
      current.reportVersion !== report.reportVersion ||
      current.reportStatus !== report.reportStatus ||
      current.reviewId !== report.reviewId ||
      current.reviewVersion !== report.reviewVersion
    )
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    return prepared;
  }
}
