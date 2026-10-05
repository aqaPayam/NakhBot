import {
  AdminActionAuthorizationService,
  PrepareSelectedReportInternalBlockHandler,
  type SelectedReportInternalBlockStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import { normalizeUserPair } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
export class PostgresSelectedReportInternalBlockStore implements SelectedReportInternalBlockStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(reportId: string): ReturnType<SelectedReportInternalBlockStore['get']> {
    const report = await this.database
      .selectFrom('moderation.reports')
      .select(['reporter_user_id', 'target_user_id', 'version', 'status'])
      .where('id', '=', reportId)
      .executeTakeFirst();
    if (report === undefined) return undefined;
    const pair = normalizeUserPair(report.reporter_user_id, report.target_user_id);
    const state = await this.database
      .selectFrom('interaction.user_pair_states')
      .select(['state', 'version'])
      .where('user_low_id', '=', pair.userLowId)
      .where('user_high_id', '=', pair.userHighId)
      .executeTakeFirst();
    return {
      reportVersion: report.version,
      reportStatus: report.status,
      reporterUserId: report.reporter_user_id,
      targetUserId: report.target_user_id,
      pairVersion: state?.version ?? 1,
      pairState: state?.state,
    };
  }
}
export class PostgresPrepareSelectedReportInternalBlockHandler extends PrepareSelectedReportInternalBlockHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresSelectedReportInternalBlockStore(database),
    );
  }
}
