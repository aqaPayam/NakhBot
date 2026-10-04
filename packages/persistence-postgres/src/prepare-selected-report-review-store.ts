import {
  AdminActionAuthorizationService,
  PrepareSelectedReportReviewHandler,
  type SelectedReportReviewStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { PostgresPrepareReviewActionHandler } from './prepare-review-action-store.js';

export class PostgresSelectedReportReviewStore implements SelectedReportReviewStore {
  public constructor(private readonly database: NakhDatabase) {}
  public get(reportId: string): ReturnType<SelectedReportReviewStore['get']> {
    return this.database
      .selectFrom('moderation.reports as report')
      .innerJoin('moderation.moderation_reviews as review', 'review.report_id', 'report.id')
      .select([
        'report.version as reportVersion',
        'report.status as reportStatus',
        'review.id as reviewId',
        'review.version as reviewVersion',
      ])
      .where('report.id', '=', reportId)
      .executeTakeFirst();
  }
}
export class PostgresPrepareSelectedReportReviewHandler extends PrepareSelectedReportReviewHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresSelectedReportReviewStore(database),
      new PostgresPrepareReviewActionHandler(database, tokens, key),
    );
  }
}
