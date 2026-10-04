import type {
  GetSelectedReportEvidenceMetadataQuery,
  GetReportEvidenceMetadataQuery,
  ReportEvidenceMetadata,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
export interface SelectedReportEvidenceMetadataStore {
  get(
    reportId: string,
  ): Promise<Readonly<{ reportVersion: number; reportStatus: string }> | undefined>;
}
/** Rechecks selected Report authority around a native metadata reader; never reads content. */
export class GetSelectedReportEvidenceMetadataHandler<
  Result extends ReportEvidenceMetadata = ReportEvidenceMetadata,
> {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reports: SelectedReportEvidenceMetadataStore,
    private readonly metadata: {
      execute(query: GetReportEvidenceMetadataQuery, actor: Actor): Promise<Result>;
    },
  ) {}
  public async execute(
    query: GetSelectedReportEvidenceMetadataQuery,
    actor: Actor,
  ): Promise<Result> {
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
      query.expectedReportVersion < 1
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const report = await this.reports.get(query.reportId);
    if (report === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (report.reportVersion !== query.expectedReportVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (
      !['submitted', 'pending_review', 'dismissed', 'actioned', 'closed'].includes(
        report.reportStatus,
      )
    )
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: query.reportId,
        expectedTargetVersion: report.reportVersion,
      },
    });
    const result = await this.metadata.execute(
      {
        actor: { kind: 'admin', userId: actor.userId },
        requestId: query.requestId,
        adminActionToken,
      },
      actor,
    );
    const current = await this.reports.get(query.reportId);
    if (
      current === undefined ||
      current.reportVersion !== report.reportVersion ||
      current.reportStatus !== report.reportStatus
    )
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (result.reportId !== query.reportId || result.items.length > 5)
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    return result;
  }
}
