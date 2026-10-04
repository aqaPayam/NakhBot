import {
  AdminActionAuthorizationService,
  PrepareReportEvidenceAccessHandler,
  type ReportEvidenceAccessStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresReportEvidenceAccessStore implements ReportEvidenceAccessStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async version(reportId: string): Promise<number | undefined> {
    const row = await this.database
      .selectFrom('moderation.reports')
      .select('version')
      .where('id', '=', reportId)
      .executeTakeFirst();
    return row?.version;
  }
}
export class PostgresPrepareReportEvidenceAccessHandler extends PrepareReportEvidenceAccessHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresReportEvidenceAccessStore(database),
    );
  }
}
