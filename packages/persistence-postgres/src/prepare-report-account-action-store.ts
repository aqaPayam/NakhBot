import {
  AdminActionAuthorizationService,
  PrepareReportAccountActionHandler,
  type ReportAccountActionPreparationStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresReportAccountActionPreparationStore implements ReportAccountActionPreparationStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(reviewId: string): ReturnType<ReportAccountActionPreparationStore['get']> {
    return this.database
      .selectFrom('moderation.moderation_reviews as review')
      .innerJoin('moderation.reports as report', 'report.id', 'review.report_id')
      .innerJoin('identity.accounts as account', 'account.user_id', 'report.target_user_id')
      .select([
        'review.version as reviewVersion',
        'review.status as reviewStatus',
        'review.assigned_admin_id as assignedAdminId',
        'report.id as reportId',
        'report.status as reportStatus',
        'report.target_user_id as targetUserId',
        'account.version as accountVersion',
        'account.state as accountState',
      ])
      .where('review.id', '=', reviewId)
      .executeTakeFirst();
  }
}
export class PostgresPrepareReportAccountActionHandler extends PrepareReportAccountActionHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresReportAccountActionPreparationStore(database),
    );
  }
}
