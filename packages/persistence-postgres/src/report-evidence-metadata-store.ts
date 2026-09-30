import {
  AdminActionAuthorizationService,
  GetReportEvidenceMetadataHandler,
  type AuthorizedAdminAction,
  type OpaqueTokenStore,
  type ReportEvidenceMetadataStore,
} from '@nakh/application';
import type { ReportEvidenceMetadata } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';

export class PostgresReportEvidenceMetadataStore implements ReportEvidenceMetadataStore {
  public constructor(private readonly database: NakhDatabase) {}
  public list(action: AuthorizedAdminAction): Promise<ReportEvidenceMetadata> {
    return this.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('administration.admin_users')
        .select('id')
        .where('id', '=', action.adminUserId)
        .forShare()
        .executeTakeFirst();
      const facts = await new PostgresAdminAuthorizationStore(transaction).loadCurrent(action);
      if (
        facts === undefined ||
        !facts.adminActive ||
        !facts.activePermissions.includes('view_reports')
      )
        throw new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
      if (
        action.targetId === null ||
        action.targetType !== 'report' ||
        action.commandCode !== 'moderation.evidence-metadata' ||
        action.requiredPermission !== 'view_reports'
      )
        throw new ApplicationError('invalid_request', 'error.admin.action_scope_invalid', 400);
      const report = await transaction
        .selectFrom('moderation.reports')
        .select(['id', 'version'])
        .where('id', '=', action.targetId)
        .forShare()
        .executeTakeFirst();
      if (report === undefined)
        throw new ApplicationError(
          'report_unavailable',
          'error.moderation.report_unavailable',
          409,
        );
      if (report.version !== action.expectedTargetVersion)
        throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
      const rows = await transaction
        .selectFrom('moderation.report_evidence as evidence')
        .innerJoin(
          'moderation.report_snapshots as snapshot',
          'snapshot.report_evidence_id',
          'evidence.id',
        )
        .select(['evidence.id', 'evidence.evidence_type', 'snapshot.schema_version'])
        .where('evidence.report_id', '=', report.id)
        .orderBy('evidence.evidence_type')
        .orderBy('evidence.id')
        .limit(6)
        .execute();
      if (rows.length > 5) throw new Error('Evidence metadata exceeds the bounded report scope.');
      return {
        reportId: report.id,
        items: rows.map((row) => ({
          evidenceId: row.id,
          evidenceType: row.evidence_type,
          snapshotSchemaVersion: row.schema_version,
        })),
      };
    });
  }
}
export class PostgresGetReportEvidenceMetadataHandler extends GetReportEvidenceMetadataHandler {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
        now,
      ),
      new PostgresReportEvidenceMetadataStore(database),
    );
  }
}
