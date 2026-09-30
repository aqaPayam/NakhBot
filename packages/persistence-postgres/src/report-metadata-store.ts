import { sql } from 'kysely';
import {
  AdminActionAuthorizationService,
  GetReportMetadataPageHandler,
  ReportMetadataCursors,
  type OpaqueTokenStore,
  type ReportMetadataReadStore,
  type ReportMetadataViewer,
  type ReportMetadataKeyset,
} from '@nakh/application';
import type { ReportMetadataPage, ReportStatus, ReportEvidenceType } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';

type Row = Readonly<{
  id: string;
  reason_code: string;
  evidence_types: ReportEvidenceType[];
  status: ReportStatus;
  priority: 'normal' | 'threshold';
  submitted_at: Date;
  cursor_time: string;
  prior_report_count: number;
  version: number;
}>;
export class PostgresReportMetadataStore implements ReportMetadataReadStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async page(
    viewer: ReportMetadataViewer,
    status: ReportStatus,
    limit: number,
    after?: ReportMetadataKeyset,
  ): Promise<
    Readonly<{ items: ReportMetadataPage['items']; next: ReportMetadataKeyset | undefined }>
  > {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ApplicationError('invalid_request', 'error.moderation.review_request_invalid', 400);
    return this.database.transaction().execute(async (transaction) => {
      // A disabled admin cannot be kept authorized by a previously issued cursor or menu.
      await transaction
        .selectFrom('administration.admin_users')
        .select('id')
        .where('id', '=', viewer.adminUserId)
        .forShare()
        .executeTakeFirst();
      const facts = await new PostgresAdminAuthorizationStore(transaction).loadCurrent(viewer);
      if (
        facts === undefined ||
        !facts.adminActive ||
        !facts.activePermissions.includes('view_reports')
      )
        throw new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
      const position =
        after === undefined
          ? sql`TRUE`
          : sql`(
        report.priority < ${after.priority} OR (report.priority = ${after.priority} AND
        (report.submitted_at, report.id) > (${after.submittedAt}::timestamptz, ${after.reportId}::uuid)))`;
      const result =
        await sql<Row>`SELECT report.id, reason.code AS reason_code, report.status, report.priority,
        report.submitted_at, to_char(report.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
        report.version,
        ARRAY(SELECT DISTINCT evidence.evidence_type FROM moderation.report_evidence evidence
          WHERE evidence.report_id = report.id ORDER BY evidence.evidence_type) AS evidence_types,
        (SELECT count(*)::integer FROM moderation.reports prior WHERE prior.target_user_id = report.target_user_id
          AND (prior.submitted_at, prior.id) < (report.submitted_at, report.id)) AS prior_report_count
        FROM moderation.reports report JOIN moderation.report_reasons reason ON reason.id = report.reason_id
        WHERE report.status = ${status} AND ${position}
        ORDER BY report.priority DESC, report.submitted_at, report.id LIMIT ${limit + 1}
      `.execute(transaction);
      const rows = result.rows.slice(0, limit),
        last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          reportId: row.id,
          reasonCode: row.reason_code,
          evidenceTypes: row.evidence_types,
          status: row.status,
          priority: row.priority,
          submittedAt: row.submitted_at.toISOString(),
          priorReportCount: row.prior_report_count,
          version: row.version,
        })),
        next:
          result.rows.length > limit && last !== undefined
            ? { priority: last.priority, submittedAt: last.cursor_time, reportId: last.id }
            : undefined,
      };
    });
  }
}
export class PostgresGetReportMetadataPageHandler extends GetReportMetadataPageHandler {
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
      new PostgresReportMetadataStore(database),
      new ReportMetadataCursors(tokens, key, now),
    );
  }
}
