import type {
  PrepareReportEvidenceAccessQuery,
  PreparedReportEvidenceAccess,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
export interface ReportEvidenceAccessStore {
  version(reportId: string): Promise<number | undefined>;
}
/** Selecting metadata grants no content access; subsequent evidence commands retain their own audits. */
export class PrepareReportEvidenceAccessHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reports: ReportEvidenceAccessStore,
  ) {}
  public async execute(
    query: PrepareReportEvidenceAccessQuery,
    actor: Actor,
  ): Promise<PreparedReportEvidenceAccess> {
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
    const version = await this.reports.version(query.reportId);
    if (version === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (version !== query.expectedReportVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
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
        expectedTargetVersion: version,
      },
    });
    return { adminActionToken, reportVersion: version };
  }
}
