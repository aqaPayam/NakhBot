import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  ModerationThresholdResult,
  ModerationThresholdStore,
  ModerationThresholdWrite,
} from '@nakh/application';
import {
  ApplicationError,
  REPORT_THRESHOLD_DISTINCT_REPORTERS,
  REPORT_THRESHOLD_WINDOW_MS,
  assertAccountTransition,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function actionDigest(
  input: Readonly<{
    targetUserId: string;
    sourceReportId: string;
    restrictionEpisodeId: string;
    distinctReporterCount: number;
  }>,
): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function insertEvent(
  database: NakhDatabase,
  input: Readonly<{
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    requestId: string;
    commandId: string;
  }>,
): Promise<void> {
  await database
    .insertInto('platform.outbox_events')
    .values({
      id: input.id,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      schema_version: 1,
      payload: input.payload,
      occurred_at: input.occurredAt,
      available_at: input.occurredAt,
      published_at: null,
      last_error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      correlation_id: input.requestId,
      causation_id: input.commandId,
    })
    .execute();
}

async function prioritizeTargetReports(
  database: NakhDatabase,
  targetUserId: string,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - REPORT_THRESHOLD_WINDOW_MS);
  await database
    .updateTable('moderation.reports')
    .set({
      status: 'pending_review',
      priority: 'threshold',
      version: sql<number>`version + 1`,
    })
    .where('target_user_id', '=', targetUserId)
    .where('status', '=', 'submitted')
    .where('submitted_at', '>', cutoff)
    .where('submitted_at', '<=', now)
    .execute();
  await database
    .updateTable('moderation.reports')
    .set({ priority: 'threshold', version: sql<number>`version + 1` })
    .where('target_user_id', '=', targetUserId)
    .where('status', '=', 'pending_review')
    .where('priority', '=', 'normal')
    .where('submitted_at', '>', cutoff)
    .where('submitted_at', '<=', now)
    .execute();
}

/**
 * Applies the threshold while already inside a Report transaction. The exported class below wraps
 * this in its own transaction for internal retries and focused persistence tests.
 */
export async function applyModerationThreshold(
  database: NakhDatabase,
  write: ModerationThresholdWrite,
): Promise<ModerationThresholdResult> {
  const source = await database
    .selectFrom('moderation.reports')
    .select(['id', 'target_user_id', 'status'])
    .where('id', '=', write.sourceReportId)
    .executeTakeFirst();
  if (source === undefined || !['submitted', 'pending_review'].includes(source.status))
    throw new ApplicationError('report_unavailable', 'error.report.unavailable', 409);

  await sql`SELECT pg_advisory_xact_lock(
    hashtextextended('moderation-threshold:' || ${source.target_user_id}::text, 0)
  )`.execute(database);
  const clock = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  const now = clock.rows[0]!.now;
  const account = await database
    .selectFrom('identity.accounts')
    .select(['state', 'version'])
    .where('user_id', '=', source.target_user_id)
    .forUpdate()
    .executeTakeFirst();
  if (account === undefined)
    throw new ApplicationError('report_unavailable', 'error.report.target_unavailable', 409);

  const countResult = await sql<{ count: number }>`
    SELECT count(DISTINCT reporter_user_id)::integer AS count
    FROM moderation.reports
    WHERE target_user_id = ${source.target_user_id}::uuid
      AND status IN ('submitted','pending_review')
      AND submitted_at > ${now}::timestamptz - interval '30 days'
      AND submitted_at <= ${now}::timestamptz
  `.execute(database);
  const distinctReporterCount = countResult.rows[0]!.count;
  if (distinctReporterCount < REPORT_THRESHOLD_DISTINCT_REPORTERS)
    return {
      sourceReportId: source.id,
      targetUserId: source.target_user_id,
      distinctReporterCount,
      outcome: 'below_threshold',
      accountVersion: account.version,
    };

  await prioritizeTargetReports(database, source.target_user_id, now);
  await database
    .insertInto('moderation.moderation_reviews')
    .values({
      id: write.reviewId,
      report_id: source.id,
      assigned_admin_id: null,
      assigned_at: null,
      decided_at: null,
      decision_note_ciphertext: null,
      decision_note_key_id: null,
      decision_note_key_version: null,
      decision_note_nonce: null,
      decision_note_sha256: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column('report_id').doNothing())
    .execute();

  const activeEpisode = await database
    .selectFrom('moderation.restriction_episodes')
    .select('id')
    .where('target_user_id', '=', source.target_user_id)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (activeEpisode !== undefined)
    return {
      sourceReportId: source.id,
      targetUserId: source.target_user_id,
      distinctReporterCount,
      outcome: 'episode_already_active',
      accountVersion: account.version,
      restrictionEpisodeId: activeEpisode.id,
    };

  if (account.state === 'restricted' || account.state === 'banned' || account.state === 'deleted')
    return {
      sourceReportId: source.id,
      targetUserId: source.target_user_id,
      distinctReporterCount,
      outcome: 'prioritize_without_transition',
      accountVersion: account.version,
    };

  assertAccountTransition(account.state, 'restricted');
  await database
    .insertInto('moderation.restriction_episodes')
    .values({
      id: write.restrictionEpisodeId,
      target_user_id: source.target_user_id,
      source_report_id: source.id,
      distinct_reporter_count: distinctReporterCount,
      started_at: now,
      resolved_at: null,
      resolved_by_admin_id: null,
      resolution_reason_code: null,
    })
    .execute();
  const updatedAccount = await database
    .updateTable('identity.accounts')
    .set({
      state: 'restricted',
      state_reason: 'distinct_reporter_threshold',
      state_changed_at: now,
      version: account.version + 1,
    })
    .where('user_id', '=', source.target_user_id)
    .where('version', '=', account.version)
    .returning('version')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('identity.account_state_history')
    .values({
      id: write.accountHistoryId,
      user_id: source.target_user_id,
      previous_state: account.state,
      next_state: 'restricted',
      reason_code: 'distinct_reporter_threshold',
      actor_type: 'system',
      actor_user_id: null,
      actor_admin_id: null,
      changed_at: now,
    })
    .execute();
  await database
    .insertInto('notification.notifications')
    .values({
      id: write.notificationId,
      user_id: source.target_user_id,
      notification_type: 'restriction_warning',
      category: 'restriction',
      title_key: 'notification.restriction_warning.title',
      body_key: 'notification.restriction_warning.body',
      payload: {},
      payload_schema_version: 1,
      deduplication_key: `moderation-threshold:${write.restrictionEpisodeId}:restriction`,
      read_at: null,
    })
    .execute();
  await database
    .insertInto('notification.notification_deliveries')
    .values({
      id: write.notificationDeliveryId,
      notification_id: write.notificationId,
      channel: 'telegram',
      sent_at: null,
      failed_at: null,
      failure_code: null,
      provider_delivery_key: null,
      lease_owner: null,
      lease_expires_at: null,
      quarantined_at: null,
    })
    .execute();
  await database
    .insertInto('platform.audit_logs')
    .values({
      id: write.auditId,
      category: 'security',
      event_type: 'moderation.threshold-restriction.v1',
      actor_type: 'system',
      actor_user_id: null,
      actor_admin_id: null,
      subject_type: 'user',
      subject_id: source.target_user_id,
      result_code: 'restricted',
      metadata_schema_version: 1,
      metadata: { reasonCode: 'distinct_reporter_threshold', distinctReporterCount },
      request_id: write.requestId,
      command_id: write.commandId,
      occurred_at: now,
    })
    .execute();
  await database
    .insertInto('moderation.moderation_actions')
    .values({
      id: write.actionId,
      action_type: 'restrict_user',
      actor_type: 'system',
      actor_admin_id: null,
      target_user_id: source.target_user_id,
      target_photo_id: null,
      target_pair_low_user_id: null,
      target_pair_high_user_id: null,
      source_report_id: source.id,
      restriction_episode_id: write.restrictionEpisodeId,
      audit_log_id: write.auditId,
      notification_id: write.notificationId,
      command_id: write.commandId,
      request_id: write.requestId,
      request_digest: actionDigest({
        targetUserId: source.target_user_id,
        sourceReportId: source.id,
        restrictionEpisodeId: write.restrictionEpisodeId,
        distinctReporterCount,
      }),
      reason_code: 'distinct_reporter_threshold',
      occurred_at: now,
    })
    .execute();

  await insertEvent(database, {
    id: write.notificationDeliveryEventId,
    aggregateType: 'notification_delivery',
    aggregateId: write.notificationDeliveryId,
    eventType: 'notification.delivery-requested.v1',
    payload: {
      notificationId: write.notificationId,
      deliveryId: write.notificationDeliveryId,
      channel: 'telegram',
    },
    occurredAt: now,
    requestId: write.requestId,
    commandId: write.commandId,
  });
  await insertEvent(database, {
    id: write.accountEventId,
    aggregateType: 'user',
    aggregateId: source.target_user_id,
    eventType: 'identity.account-state-changed.v1',
    payload: {
      userId: source.target_user_id,
      previousState: account.state,
      nextState: 'restricted',
      reasonCode: 'distinct_reporter_threshold',
      accountVersion: updatedAccount.version,
    },
    occurredAt: now,
    requestId: write.requestId,
    commandId: write.commandId,
  });
  await insertEvent(database, {
    id: write.thresholdEventId,
    aggregateType: 'restriction_episode',
    aggregateId: write.restrictionEpisodeId,
    eventType: 'moderation.threshold-reached.v1',
    payload: {
      restrictionEpisodeId: write.restrictionEpisodeId,
      targetUserId: source.target_user_id,
      distinctReporterCount,
    },
    occurredAt: now,
    requestId: write.requestId,
    commandId: write.commandId,
  });
  await insertEvent(database, {
    id: write.actionEventId,
    aggregateType: 'moderation_action',
    aggregateId: write.actionId,
    eventType: 'moderation.action-recorded.v1',
    payload: {
      actionId: write.actionId,
      actionType: 'restrict_user',
      targetUserId: source.target_user_id,
      restrictionEpisodeId: write.restrictionEpisodeId,
    },
    occurredAt: now,
    requestId: write.requestId,
    commandId: write.commandId,
  });

  return {
    sourceReportId: source.id,
    targetUserId: source.target_user_id,
    distinctReporterCount,
    outcome: 'create_restriction_episode',
    accountVersion: updatedAccount.version,
    restrictionEpisodeId: write.restrictionEpisodeId,
  };
}

export class PostgresModerationThresholdStore implements ModerationThresholdStore {
  public constructor(private readonly database: NakhDatabase) {}

  public evaluate(write: ModerationThresholdWrite): Promise<ModerationThresholdResult> {
    return this.database
      .transaction()
      .execute((transaction) => applyModerationThreshold(transaction, write));
  }
}
