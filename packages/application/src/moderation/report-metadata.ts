import type { GetReportMetadataPageQuery, ReportMetadataPage, ReportStatus } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type {
  ReportMetadataCursors,
  ReportMetadataKeyset,
  ReportMetadataViewer,
} from './report-metadata-cursor.js';
export interface ReportMetadataReadStore {
  page(
    viewer: ReportMetadataViewer,
    status: ReportStatus,
    limit: number,
    after?: ReportMetadataKeyset,
  ): Promise<
    Readonly<{
      items: ReportMetadataPage['items'];
      next: ReportMetadataKeyset | undefined;
    }>
  >;
}
function invalid(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.moderation.review_request_invalid', 400);
}
export class GetReportMetadataPageHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize'>,
    private readonly store: ReportMetadataReadStore,
    private readonly cursors: Pick<ReportMetadataCursors, 'issue' | 'resolve'>,
  ) {}
  public async execute(
    query: GetReportMetadataPageQuery,
    actor: Actor,
  ): Promise<ReportMetadataPage> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      actor.userId !== query.actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const status = query.status ?? 'pending_review';
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 50 ||
      !['submitted', 'pending_review', 'dismissed', 'actioned', 'closed'].includes(status)
    )
      throw invalid();
    const action = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
    });
    if (action.targetId !== null || action.expectedTargetVersion !== null) throw invalid();
    const viewer = { adminUserId: action.adminUserId, actorUserId: action.actorUserId };
    const after =
      query.cursor === undefined
        ? undefined
        : await this.cursors.resolve(query.cursor, viewer, status);
    if (query.cursor !== undefined && after === undefined) throw invalid();
    const page = await this.store.page(viewer, status, query.limit, after);
    return {
      items: page.items,
      ...(page.next === undefined
        ? {}
        : { nextCursor: await this.cursors.issue(viewer, status, page.next) }),
    };
  }
}
