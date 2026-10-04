import {
  AdminActionAuthorizationService,
  GetSelectedReportEvidenceMetadataHandler,
  type OpaqueTokenStore,
  type SelectedReportEvidenceMetadataStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresSelectedReportEvidenceMetadataStore implements SelectedReportEvidenceMetadataStore {
  public constructor(private readonly database: NakhDatabase) {}
  public get(reportId: string): ReturnType<SelectedReportEvidenceMetadataStore['get']> {
    return this.database
      .selectFrom('moderation.reports')
      .select(['version as reportVersion', 'status as reportStatus'])
      .where('id', '=', reportId)
      .executeTakeFirst();
  }
}
import { PostgresGetReportEvidenceMetadataHandler } from './report-evidence-metadata-store.js';
export class PostgresGetSelectedReportEvidenceMetadataHandler extends GetSelectedReportEvidenceMetadataHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresSelectedReportEvidenceMetadataStore(database),
      new PostgresGetReportEvidenceMetadataHandler(database, tokens, key),
    );
  }
}
