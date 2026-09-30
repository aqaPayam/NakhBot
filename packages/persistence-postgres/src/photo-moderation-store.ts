import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';

import {
  PhotoModerationWorkflow,
  type PhotoAdminAction,
  type PhotoDeliveryRevocation,
  type PhotoModerationResult,
  type PhotoModerationWorkflowStore,
  type PhotoModerationWrite,
} from '@nakh/application';

import { PostgresAdminCommandStore } from './admin-command-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { applyPhotoModeration } from './photo-management-store.js';

function lifecycleAction(action: PhotoAdminAction): 'hide' | 'restore' | 'delete' {
  switch (action) {
    case 'hide_photo':
      return 'hide';
    case 'restore_photo':
      return 'restore';
    case 'delete_photo':
      return 'delete';
  }
}

export class PostgresPhotoModerationStore implements PhotoModerationWorkflowStore<NakhDatabase> {
  public async apply(
    database: NakhDatabase,
    write: PhotoModerationWrite,
  ): Promise<PhotoModerationResult> {
    if (write.sourceReportId !== undefined) {
      const target = await database
        .selectFrom('media.profile_photos as photo')
        .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
        .innerJoin('moderation.reports as report', 'report.target_user_id', 'profile.user_id')
        .select('profile.user_id')
        .where('photo.id', '=', write.photoId)
        .where('report.id', '=', write.sourceReportId)
        .executeTakeFirst();
      if (target === undefined)
        throw new ApplicationError(
          'report_unavailable',
          'error.moderation.review_unavailable',
          409,
        );
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${target.user_id}::text, 0))`.execute(
        database,
      );
    }
    const time = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
    const occurredAt = time.rows[0]!.now;
    const result = await applyPhotoModeration(database, {
      adminId: write.adminUserId,
      photoId: write.photoId,
      expectedPhotoVersion: write.expectedPhotoVersion,
      action: lifecycleAction(write.action),
      reasonCode: write.reasonCode,
      sourceReportId: write.sourceReportId ?? null,
      moderationId: write.moderationId,
      auditId: write.auditId,
      eventId: write.eventId,
      profileEventId: write.profileEventId,
      requestId: write.requestId,
      commandId: write.commandId,
      occurredAt,
    });
    // The lifecycle owns user/profile/photo locks. Validate and lock report/review next; any
    // rejection rolls its photo history, audit and state changes back to the command savepoint.
    if (write.sourceReportId !== undefined) {
      const report = await database
        .selectFrom('moderation.reports')
        .select(['target_user_id', 'status'])
        .where('id', '=', write.sourceReportId)
        .forUpdate()
        .executeTakeFirst();
      const review = await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'assigned_admin_id'])
        .where('report_id', '=', write.sourceReportId)
        .forUpdate()
        .executeTakeFirst();
      if (
        report?.target_user_id !== result.targetUserId ||
        report.status !== 'pending_review' ||
        review?.status !== 'in_review'
      )
        throw new ApplicationError(
          'report_unavailable',
          'error.moderation.review_unavailable',
          409,
        );
      if (review.assigned_admin_id !== write.adminUserId)
        throw new ApplicationError(
          'reviewer_unauthorized',
          'error.moderation.reviewer_unauthorized',
          403,
        );
    }
    await database
      .insertInto('moderation.moderation_actions')
      .values({
        id: write.actionId,
        action_type: write.action,
        actor_type: 'admin',
        actor_admin_id: write.adminUserId,
        target_user_id: null,
        target_photo_id: write.photoId,
        target_pair_low_user_id: null,
        target_pair_high_user_id: null,
        source_report_id: write.sourceReportId ?? null,
        restriction_episode_id: null,
        audit_log_id: write.auditId,
        notification_id: null,
        command_id: write.commandId,
        request_id: write.requestId,
        request_digest: write.requestDigest,
        reason_code: write.reasonCode,
        occurred_at: occurredAt,
      })
      .execute();
    await database
      .insertInto('platform.outbox_events')
      .values({
        id: write.actionEventId,
        aggregate_type: 'moderation_action',
        aggregate_id: write.actionId,
        event_type: 'moderation.action-recorded.v1',
        schema_version: 1,
        payload: {
          actionId: write.actionId,
          actionType: write.action,
          photoId: write.photoId,
          targetUserId: result.targetUserId,
          photoVersion: result.photoVersion,
          profileVersion: result.profileVersion,
        },
        occurred_at: occurredAt,
        available_at: occurredAt,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: write.requestId,
        causation_id: write.commandId,
      })
      .execute();
    return { actionId: write.actionId, ...result };
  }
}

/** Production composition that makes every photo effect share its immutable admin-attempt commit. */
export class PostgresPhotoModerationWorkflow extends PhotoModerationWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase, delivery: PhotoDeliveryRevocation) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresPhotoModerationStore(),
      delivery,
      new SystemIdGenerator(),
    );
  }
}
