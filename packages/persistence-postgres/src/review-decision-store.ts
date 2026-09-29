import { sql } from 'kysely';
import {
  ReviewDecisionWorkflow,
  type ReviewDecisionStore,
  type ReviewDecisionWrite,
  type ReviewDecisionResult,
  type ReviewNoteProtector,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { SystemIdGenerator } from './foundation-store.js';

function unavailable(): ApplicationError {
  return new ApplicationError('report_unavailable', 'error.moderation.review_unavailable', 409);
}
export class PostgresReviewDecisionStore implements ReviewDecisionStore<NakhDatabase> {
  public async decide(
    database: NakhDatabase,
    write: ReviewDecisionWrite,
  ): Promise<ReviewDecisionResult> {
    const { attempt, decision, note } = write;
    // Immutable relationship lookup precedes the shared threshold lock and row locks.
    const initial = await database
      .selectFrom('moderation.moderation_reviews as review')
      .innerJoin('moderation.reports as report', 'report.id', 'review.report_id')
      .select(['report.target_user_id', 'report.id'])
      .where('review.id', '=', attempt.targetId)
      .executeTakeFirst();
    if (initial === undefined) throw unavailable();
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${initial.target_user_id}::text, 0))`.execute(
      database,
    );
    const report = await database
      .selectFrom('moderation.reports')
      .select(['status', 'version'])
      .where('id', '=', initial.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const review = await database
      .selectFrom('moderation.moderation_reviews')
      .select(['status', 'assigned_admin_id', 'version'])
      .where('id', '=', attempt.targetId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (review.version !== attempt.expectedTargetVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    if (review.status !== 'in_review' || report.status !== 'pending_review') throw unavailable();
    if (review.assigned_admin_id !== attempt.adminUserId)
      throw new ApplicationError(
        'reviewer_unauthorized',
        'error.moderation.reviewer_unauthorized',
        403,
      );
    // Finalizing a report never grants permission to perform a separate account/photo/pair action.
    if (decision === 'actioned') {
      const action = await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('source_report_id', '=', initial.id)
        .where('actor_type', '=', 'admin')
        .where('action_type', '!=', 'dismiss_report')
        .executeTakeFirst();
      if (action === undefined) throw unavailable();
    }
    const updated = await database
      .updateTable('moderation.moderation_reviews')
      .set({
        status: decision,
        decided_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`clock_timestamp()`,
        version: review.version + 1,
        decision_note_ciphertext: note === undefined ? null : Buffer.from(note.ciphertext),
        decision_note_key_id: note?.keyId ?? null,
        decision_note_key_version: note?.keyVersion ?? null,
        decision_note_nonce: note === undefined ? null : Buffer.from(note.nonce),
        decision_note_sha256: note?.sha256 ?? null,
      })
      .where('id', '=', attempt.targetId)
      .returning(['version', 'decided_at'])
      .executeTakeFirstOrThrow();
    const now = updated.decided_at!;
    await database
      .updateTable('moderation.reports')
      .set({ status: decision, reviewed_at: now, version: report.version + 1 })
      .where('id', '=', initial.id)
      .execute();
    await database
      .insertInto('platform.audit_logs')
      .values({
        id: write.auditId,
        category: 'admin',
        event_type: 'moderation.review-decided.v1',
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: attempt.adminUserId,
        subject_type: 'moderation_review',
        subject_id: attempt.targetId,
        result_code: `review_${decision}`,
        metadata_schema_version: 1,
        metadata: { status: decision, version: updated.version },
        request_id: attempt.requestId,
        command_id: attempt.commandId,
        occurred_at: now,
      })
      .execute();
    if (decision === 'dismissed')
      await database
        .insertInto('moderation.moderation_actions')
        .values({
          id: write.actionId,
          action_type: 'dismiss_report',
          actor_type: 'admin',
          actor_admin_id: attempt.adminUserId,
          target_user_id: initial.target_user_id,
          target_photo_id: null,
          target_pair_low_user_id: null,
          target_pair_high_user_id: null,
          source_report_id: initial.id,
          restriction_episode_id: null,
          audit_log_id: write.auditId,
          notification_id: null,
          command_id: attempt.commandId,
          request_id: attempt.requestId,
          request_digest: attempt.requestDigest,
          reason_code: 'report_dismissed',
          occurred_at: now,
        })
        .execute();
    await database
      .insertInto('platform.outbox_events')
      .values({
        id: write.eventId,
        aggregate_type: 'moderation_review',
        aggregate_id: attempt.targetId,
        event_type: 'moderation.review-decided.v1',
        schema_version: 1,
        payload: { reviewId: attempt.targetId, status: decision, version: updated.version },
        occurred_at: now,
        available_at: now,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: attempt.requestId,
        causation_id: attempt.commandId,
      })
      .execute();
    return {
      reviewId: attempt.targetId,
      reportId: initial.id,
      status: decision,
      version: updated.version,
    };
  }
}
export class PostgresReviewDecisionWorkflow extends ReviewDecisionWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase, notes: ReviewNoteProtector) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresReviewDecisionStore(),
      notes,
      new SystemIdGenerator(),
    );
  }
}
