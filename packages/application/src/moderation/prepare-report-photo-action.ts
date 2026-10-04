import type { PrepareReportPhotoActionQuery, PreparedReportPhotoAction } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
export interface ReportPhotoActionPreparationStore {
  get(
    reviewId: string,
    evidenceId: string,
  ): Promise<
    | Readonly<{
        reviewVersion: number;
        reviewStatus: string;
        assignedAdminId: string | null;
        reportId: string;
        reportStatus: string;
        photoId: string;
        photoVersion: number;
      }>
    | undefined
  >;
}
/** Selection names evidence; photo identity and version are resolved by its owning store. */
export class PrepareReportPhotoActionHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly photos: ReportPhotoActionPreparationStore,
  ) {}
  public async execute(
    query: PrepareReportPhotoActionQuery,
    actor: Actor,
  ): Promise<PreparedReportPhotoAction> {
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
      !['hide_photo', 'restore_photo', 'delete_photo'].includes(query.action)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const source = await this.photos.get(query.reviewId, query.evidenceId);
    if (source === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (source.reviewVersion !== query.expectedReviewVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (source.reviewStatus !== 'in_review' || source.reportStatus !== 'pending_review')
      throw new ApplicationError('conflict', 'error.m7.unavailable', 409);
    if (source.assignedAdminId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.moderation.reviewer_unauthorized', 403);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'moderation.apply-photo-action',
        requiredPermission: query.action,
        targetType: 'photo',
        targetId: source.photoId,
        expectedTargetVersion: source.photoVersion,
        sourceReportId: source.reportId,
      },
    });
    return { adminActionToken, photoVersion: source.photoVersion };
  }
}
