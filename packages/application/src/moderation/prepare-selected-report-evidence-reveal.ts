import type {
  PrepareSelectedReportEvidenceRevealQuery,
  PreparedReportEvidenceReveal,
  ReportEvidenceActions,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { GetSelectedReportEvidenceMetadataHandler } from './selected-report-evidence-metadata.js';

/** Selects a native immutable-evidence grant; reading still requires separate confirmation. */
export class PrepareSelectedReportEvidenceRevealHandler {
  public constructor(
    private readonly actions: Pick<
      GetSelectedReportEvidenceMetadataHandler<ReportEvidenceActions>,
      'execute'
    >,
  ) {}
  public async execute(
    query: PrepareSelectedReportEvidenceRevealQuery,
    actor: Actor,
  ): Promise<PreparedReportEvidenceReveal> {
    const result = await this.actions.execute(
      {
        actor: query.actor,
        requestId: query.requestId,
        adminActionToken: query.adminActionToken,
        reportId: query.reportId,
        expectedReportVersion: query.expectedReportVersion,
      },
      actor,
    );
    const matches = result.items.filter((item) => item.evidenceId === query.evidenceId);
    if (matches.length === 0) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (matches.length !== 1 || result.reportId !== query.reportId || result.items.length > 5)
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    const selected = matches[0]!;
    if (selected.snapshotSchemaVersion !== 1 || selected.revealActionToken === undefined)
      throw new ApplicationError('report_unavailable', 'error.m7.unavailable', 409);
    return { adminActionToken: selected.revealActionToken };
  }
}
