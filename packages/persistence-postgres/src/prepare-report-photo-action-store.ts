import {
  AdminActionAuthorizationService,
  PrepareReportPhotoActionHandler,
  type ReportPhotoActionPreparationStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresReportPhotoActionPreparationStore implements ReportPhotoActionPreparationStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(
    reviewId: string,
    evidenceId: string,
  ): ReturnType<ReportPhotoActionPreparationStore['get']> {
    return this.database
      .selectFrom('moderation.moderation_reviews as review')
      .innerJoin('moderation.reports as report', 'report.id', 'review.report_id')
      .innerJoin('moderation.report_evidence as evidence', 'evidence.report_id', 'report.id')
      .innerJoin('media.profile_photos as photo', 'photo.id', 'evidence.profile_photo_id')
      .innerJoin('profile.profiles as profile', (join) =>
        join
          .onRef('profile.id', '=', 'photo.profile_id')
          .onRef('profile.user_id', '=', 'report.target_user_id'),
      )
      .select([
        'review.version as reviewVersion',
        'review.status as reviewStatus',
        'review.assigned_admin_id as assignedAdminId',
        'report.id as reportId',
        'report.status as reportStatus',
        'photo.id as photoId',
        'photo.version as photoVersion',
      ])
      .where('review.id', '=', reviewId)
      .where('evidence.id', '=', evidenceId)
      .where('evidence.evidence_type', '=', 'photo')
      .executeTakeFirst();
  }
}
export class PostgresPrepareReportPhotoActionHandler extends PrepareReportPhotoActionHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresReportPhotoActionPreparationStore(database),
    );
  }
}
