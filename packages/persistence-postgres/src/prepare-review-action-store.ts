import {
  AdminActionAuthorizationService,
  PrepareReviewActionHandler,
  type ReviewActionPreparationStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresReviewActionPreparationStore implements ReviewActionPreparationStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(reviewId: string): ReturnType<ReviewActionPreparationStore['get']> {
    const row = await this.database
      .selectFrom('moderation.moderation_reviews as review')
      .innerJoin('moderation.reports as report', 'report.id', 'review.report_id')
      .select([
        'review.version',
        'review.status',
        'review.assigned_admin_id as assignedAdminId',
        'report.status as reportStatus',
        'report.id as reportId',
      ])
      .where('review.id', '=', reviewId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const action = await this.database
      .selectFrom('moderation.moderation_actions')
      .select('id')
      .where('source_report_id', '=', row.reportId)
      .where('actor_type', '=', 'admin')
      .where('action_type', '!=', 'dismiss_report')
      .executeTakeFirst();
    return {
      version: row.version,
      status: row.status,
      assignedAdminId: row.assignedAdminId,
      reportStatus: row.reportStatus,
      hasModerationAction: action !== undefined,
    };
  }
}
export class PostgresPrepareReviewActionHandler extends PrepareReviewActionHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresReviewActionPreparationStore(database),
    );
  }
}
