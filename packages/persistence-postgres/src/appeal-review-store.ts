import { sql } from 'kysely';

import {
  AppealReviewWorkflow,
  type AppealReviewStore,
  type AppealReviewWrite,
} from '@nakh/application';
import type { AppealResult } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import { PostgresAdminCommandStore } from './admin-command-store.js';
import { currentBan, lockAppealAccount } from './appeal-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';

function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.appeal.review_unavailable', 409);
}

export class PostgresAppealReviewStore implements AppealReviewStore<NakhDatabase> {
  public async review(database: NakhDatabase, write: AppealReviewWrite): Promise<AppealResult> {
    // The owner is immutable. Read it before taking locks in account -> appeal order.
    const initial = await database
      .selectFrom('moderation.user_appeals')
      .select('user_id')
      .where('id', '=', write.appealId)
      .executeTakeFirst();
    if (initial === undefined) throw unavailable();
    await lockAppealAccount(database, initial.user_id);
    const banId = await currentBan(database, initial.user_id);
    const appeal = await database
      .selectFrom('moderation.user_appeals')
      .selectAll()
      .where('id', '=', write.appealId)
      .forUpdate()
      .executeTakeFirst();
    if (appeal === undefined || appeal.ban_state_history_id !== banId) throw unavailable();
    if (appeal.version !== write.expectedVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    if (appeal.status !== 'submitted' && appeal.status !== 'in_review') throw unavailable();
    const updated = await database
      .updateTable('moderation.user_appeals')
      .set({
        status: write.decision,
        reviewed_by_admin_id: write.adminUserId,
        admin_note: write.normalizedNote ?? null,
        reviewed_at: sql<Date>`transaction_timestamp()`,
        version: appeal.version + 1,
      })
      .where('id', '=', write.appealId)
      .returning(['version', 'reviewed_at'])
      .executeTakeFirstOrThrow();
    await database
      .insertInto('platform.audit_logs')
      .values({
        id: write.auditId,
        category: 'admin',
        event_type: 'moderation.appeal-reviewed.v1',
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: write.adminUserId,
        subject_type: 'user_appeal',
        subject_id: write.appealId,
        result_code: `appeal_${write.decision}`,
        metadata_schema_version: 1,
        metadata: { status: write.decision, version: updated.version },
        request_id: write.requestId,
        command_id: write.commandId,
        occurred_at: updated.reviewed_at!,
      })
      .execute();
    await database
      .insertInto('platform.outbox_events')
      .values({
        id: write.eventId,
        aggregate_type: 'user_appeal',
        aggregate_id: write.appealId,
        event_type: 'moderation.appeal-changed.v1',
        schema_version: 1,
        payload: { appealId: write.appealId, status: write.decision, version: updated.version },
        occurred_at: updated.reviewed_at!,
        available_at: updated.reviewed_at!,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: write.requestId,
        causation_id: write.commandId,
      })
      .execute();
    return {
      appealId: write.appealId,
      status: write.decision,
      version: updated.version,
      changedAt: updated.reviewed_at!.toISOString(),
      replayed: false,
    };
  }
}

export class PostgresAppealReviewWorkflow extends AppealReviewWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresAppealReviewStore(),
      new SystemIdGenerator(),
    );
  }
}
