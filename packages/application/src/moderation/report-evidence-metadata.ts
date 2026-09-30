import type { GetReportEvidenceMetadataQuery, ReportEvidenceMetadata } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type {
  AdminActionAuthorizationService,
  AuthorizedAdminAction,
} from '../administration/admin-authorization.js';
export interface ReportEvidenceMetadataStore {
  list(action: AuthorizedAdminAction): Promise<ReportEvidenceMetadata>;
}
export class GetReportEvidenceMetadataHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize'>,
    private readonly store: ReportEvidenceMetadataStore,
  ) {}
  public async execute(
    query: GetReportEvidenceMetadataQuery,
    actor: Actor,
  ): Promise<ReportEvidenceMetadata> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      actor.userId !== query.actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const action = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.evidence-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report',
    });
    if (action.targetId === null || action.expectedTargetVersion === null)
      throw new ApplicationError('invalid_request', 'error.admin.action_scope_invalid', 400);
    return this.store.list(action);
  }
}
