import { sql } from 'kysely';

import {
  ModerationReviewWorkflow,
  type AssignedModerationReview,
  type ClaimedModerationReview,
  type ModerationReviewWorkflowStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import { PostgresAdminCommandStore } from './admin-command-store.js';
import type { NakhDatabase } from './database.js';

type ClaimedRow = Readonly<{
  review_id: string;
  report_id: string;
  review_version: number;
  priority: 'normal' | 'threshold';
}>;

function unavailable(): ApplicationError {
  return new ApplicationError('report_unavailable', 'error.moderation.review_unavailable', 409);
}

async function canReviewReports(database: NakhDatabase, adminUserId: string): Promise<boolean> {
  const row = await database
    .selectFrom('administration.admin_users as admin')
    .innerJoin(
      'administration.admin_user_roles as assignment',
      'assignment.admin_user_id',
      'admin.id',
    )
    .innerJoin('administration.admin_roles as role', 'role.code', 'assignment.role_code')
    .innerJoin(
      'administration.admin_role_permissions as role_permission',
      'role_permission.role_code',
      'role.code',
    )
    .select('admin.id')
    .where('admin.id', '=', adminUserId)
    .where('admin.is_active', '=', true)
    .where('assignment.revoked_at', 'is', null)
    .where('role.is_active', '=', true)
    .where('role_permission.permission_code', '=', 'view_reports')
    .executeTakeFirst();
  return row !== undefined;
}

export class PostgresModerationReviewStore implements ModerationReviewWorkflowStore<NakhDatabase> {
  public async claim(
    database: NakhDatabase,
    input: Readonly<{ adminUserId: string; limit: number }>,
  ): Promise<readonly ClaimedModerationReview[]> {
    const result = await sql<ClaimedRow>`
      WITH candidates AS (
        SELECT review.id, report.priority, review.created_at
        FROM moderation.moderation_reviews review
        JOIN moderation.reports report ON report.id = review.report_id
        WHERE review.status = 'pending' AND report.status = 'pending_review'
        ORDER BY CASE report.priority WHEN 'threshold' THEN 0 ELSE 1 END,
          review.created_at, review.id
        FOR UPDATE OF review SKIP LOCKED
        LIMIT ${input.limit}
      ), updated AS (
        UPDATE moderation.moderation_reviews review
        SET status = 'in_review', assigned_admin_id = ${input.adminUserId}::uuid,
          assigned_at = transaction_timestamp(), updated_at = transaction_timestamp(),
          version = review.version + 1
        FROM candidates
        WHERE review.id = candidates.id
        RETURNING review.id AS review_id, review.report_id, review.version AS review_version
      )
      SELECT updated.review_id, updated.report_id, updated.review_version, candidates.priority
      FROM updated JOIN candidates ON candidates.id = updated.review_id
      ORDER BY CASE candidates.priority WHEN 'threshold' THEN 0 ELSE 1 END,
        candidates.created_at, candidates.id
    `.execute(database);
    return result.rows.map((row) => ({
      reviewId: row.review_id,
      reportId: row.report_id,
      reviewVersion: row.review_version,
      priority: row.priority,
    }));
  }

  public async assign(
    database: NakhDatabase,
    input: Readonly<{
      reviewId: string;
      assigneeAdminId: string;
      expectedVersion: number;
    }>,
  ): Promise<AssignedModerationReview> {
    const review = await database
      .selectFrom('moderation.moderation_reviews as review')
      .innerJoin('moderation.reports as report', 'report.id', 'review.report_id')
      .select([
        'review.report_id',
        'review.status',
        'review.assigned_admin_id',
        'review.version',
        'report.status as report_status',
      ])
      .where('review.id', '=', input.reviewId)
      .forUpdate('review')
      .executeTakeFirst();
    if (
      review === undefined ||
      review.report_status !== 'pending_review' ||
      (review.status !== 'pending' && review.status !== 'in_review')
    )
      throw unavailable();
    if (review.version !== input.expectedVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    if (review.assigned_admin_id === input.assigneeAdminId) throw unavailable();
    if (!(await canReviewReports(database, input.assigneeAdminId)))
      throw new ApplicationError(
        'reviewer_unauthorized',
        'error.moderation.reviewer_unauthorized',
        403,
      );

    const updated = await database
      .updateTable('moderation.moderation_reviews')
      .set((expression) => ({
        status: 'in_review',
        assigned_admin_id: input.assigneeAdminId,
        assigned_at: sql<Date>`transaction_timestamp()`,
        updated_at: sql<Date>`transaction_timestamp()`,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', input.reviewId)
      .where('version', '=', input.expectedVersion)
      .returning(['report_id', 'assigned_admin_id', 'version'])
      .executeTakeFirstOrThrow();
    return {
      reviewId: input.reviewId,
      reportId: updated.report_id,
      assignedAdminId: updated.assigned_admin_id!,
      reviewVersion: updated.version,
    };
  }
}

/** Production composition that cannot commit a review mutation without its AdminActionLog. */
export class PostgresModerationReviewWorkflow extends ModerationReviewWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    super(new PostgresAdminCommandStore(database), new PostgresModerationReviewStore());
  }
}
