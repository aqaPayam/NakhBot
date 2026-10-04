import {
  AdminActionAuthorizationService,
  PrepareSelectedReportAccountActionHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { PostgresSelectedReportReviewStore } from './prepare-selected-report-review-store.js';
import { PostgresPrepareReportAccountActionHandler } from './prepare-report-account-action-store.js';
export class PostgresPrepareSelectedReportAccountActionHandler extends PrepareSelectedReportAccountActionHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresSelectedReportReviewStore(database),
      new PostgresPrepareReportAccountActionHandler(database, tokens, key),
    );
  }
}
