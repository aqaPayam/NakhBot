import type { GetReportEvidenceMetadataQuery, ReportEvidenceActions } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type { GetReportEvidenceMetadataHandler } from './report-evidence-metadata.js';

/** Issues only from metadata recovered through the report-scoped authorization boundary. */
export class GetReportEvidenceActionsHandler {
  public constructor(
    private readonly metadata: Pick<GetReportEvidenceMetadataHandler, 'execute'>,
    private readonly issue: (actor: Actor, evidenceId: string) => Promise<string>,
    private readonly supportedTypes: readonly ('profile' | 'chat')[] = ['profile'],
  ) {}
  public async execute(
    query: GetReportEvidenceMetadataQuery,
    actor: Actor,
  ): Promise<ReportEvidenceActions> {
    const metadata = await this.metadata.execute(query, actor);
    const items: ReportEvidenceActions['items'] = [];
    for (const item of metadata.items) {
      items.push({
        ...item,
        ...(this.supportedTypes.some((type) => type === item.evidenceType) &&
        item.snapshotSchemaVersion === 1
          ? { revealActionToken: await this.issue(actor, item.evidenceId) }
          : {}),
      });
    }
    return { reportId: metadata.reportId, items };
  }
}
