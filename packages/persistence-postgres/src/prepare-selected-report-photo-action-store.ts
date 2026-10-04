import {
  AdminActionAuthorizationService,
  PrepareSelectedReportPhotoActionHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { PostgresSelectedReportReviewStore } from './prepare-selected-report-review-store.js';
import { PostgresPrepareReportPhotoActionHandler } from './prepare-report-photo-action-store.js';
export class PostgresPrepareSelectedReportPhotoActionHandler extends PrepareSelectedReportPhotoActionHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresSelectedReportReviewStore(database),
      new PostgresPrepareReportPhotoActionHandler(database, tokens, key),
    );
  }
}
