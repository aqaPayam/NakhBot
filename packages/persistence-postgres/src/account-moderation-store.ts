import { sql } from 'kysely';

import {
  AccountModerationWorkflow,
  type AccountModerationAction,
  type AccountModerationResult,
  type AccountModerationWorkflowStore,
  type AccountModerationWrite,
} from '@nakh/application';
import {
  ApplicationError,
  assertAccountTransition,
  type AccountState,
  type NotificationCategory,
  type NotificationType,
} from '@nakh/domain';

import { PostgresAdminCommandStore } from './admin-command-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';

type Notice = Readonly<{
  type: NotificationType;
  category: NotificationCategory;
  titleKey: string;
  bodyKey: string;
}>;

function unavailable(): ApplicationError {
  return new ApplicationError(
    'moderation_state_invalid',
    'error.moderation.account_action_unavailable',
    409,
  );
}

function reasonCode(action: AccountModerationAction): string {
  return `admin_${action}`;
}

function notice(action: AccountModerationAction): Notice {
  switch (action) {
    case 'restrict_user':
      return {
        type: 'restriction_warning',
        category: 'restriction',
        titleKey: 'notification.restriction_warning.title',
        bodyKey: 'notification.restriction_warning.body',
      };
    case 'ban_user':
      return {
        type: 'ban_warning',
        category: 'ban',
        titleKey: 'notification.ban_warning.title',
        bodyKey: 'notification.ban_warning.body',
      };
    case 'unrestrict_user':
      return {
        type: 'admin_notice',
        category: 'admin',
        titleKey: 'notification.account_unrestricted.title',
        bodyKey: 'notification.account_unrestricted.body',
      };
    case 'unban_user':
      return {
        type: 'admin_notice',
        category: 'admin',
        titleKey: 'notification.account_unbanned.title',
        bodyKey: 'notification.account_unbanned.body',
      };
  }
}

async function restoredState(
  database: NakhDatabase,
  targetUserId: string,
  action: 'unrestrict_user' | 'unban_user',
): Promise<AccountState> {
  let query = database
    .selectFrom('identity.account_state_history')
    .select('previous_state')
    .where('user_id', '=', targetUserId)
    .where('next_state', '=', action === 'unban_user' ? 'banned' : 'restricted');
  if (action === 'unrestrict_user') query = query.where('previous_state', '!=', 'banned');
  const history = await query
    .orderBy('changed_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (history?.previous_state === null || history?.previous_state === undefined)
    throw unavailable();
  return history.previous_state;
}

async function nextState(
  database: NakhDatabase,
  targetUserId: string,
  current: AccountState,
  action: AccountModerationAction,
): Promise<AccountState> {
  switch (action) {
    case 'restrict_user':
      if (!['guest', 'incomplete', 'active'].includes(current)) throw unavailable();
      return 'restricted';
    case 'ban_user':
      if (!['guest', 'incomplete', 'active', 'restricted'].includes(current)) throw unavailable();
      return 'banned';
    case 'unrestrict_user':
      if (current !== 'restricted') throw unavailable();
      return restoredState(database, targetUserId, action);
    case 'unban_user':
      if (current !== 'banned') throw unavailable();
      return restoredState(database, targetUserId, action);
  }
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

export class PostgresAccountModerationStore implements AccountModerationWorkflowStore<NakhDatabase> {
  public async apply(
    database: NakhDatabase,
    write: AccountModerationWrite,
  ): Promise<AccountModerationResult> {
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended('moderation-account:' || ${write.targetUserId}::text, 0)
    )`.execute(database);
    const account = await database
      .selectFrom('identity.accounts')
      .select(['state', 'version'])
      .where('user_id', '=', write.targetUserId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined) throw unavailable();
    if (account.version !== write.expectedAccountVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);

    const state = await nextState(database, write.targetUserId, account.state, write.action);
    assertAccountTransition(account.state, state);
    const nowResult = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
      database,
    );
    const now = nowResult.rows[0]!.now;
    const code = reasonCode(write.action);
    const notification = notice(write.action);
    let restrictionEpisodeId: string | null = null;

    if (write.action === 'unrestrict_user') {
      const episode = await database
        .selectFrom('moderation.restriction_episodes')
        .select('id')
        .where('target_user_id', '=', write.targetUserId)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      if (episode !== undefined) {
        restrictionEpisodeId = episode.id;
        await database
          .updateTable('moderation.restriction_episodes')
          .set((expression) => ({
            status: 'resolved',
            resolved_at: now,
            resolved_by_admin_id: write.adminUserId,
            resolution_reason_code: code,
            version: expression('version', '+', 1),
          }))
          .where('id', '=', episode.id)
          .execute();
      }
    }

    const updated = await database
      .updateTable('identity.accounts')
      .set({
        state,
        state_reason: code,
        state_changed_at: now,
        version: account.version + 1,
      })
      .where('user_id', '=', write.targetUserId)
      .where('version', '=', write.expectedAccountVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);

    await database
      .insertInto('identity.account_state_history')
      .values({
        id: write.accountHistoryId,
        user_id: write.targetUserId,
        previous_state: account.state,
        next_state: state,
        reason_code: code,
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: write.adminUserId,
        changed_at: now,
      })
      .execute();
    await database
      .insertInto('notification.notifications')
      .values({
        id: write.notificationId,
        user_id: write.targetUserId,
        notification_type: notification.type,
        category: notification.category,
        title_key: notification.titleKey,
        body_key: notification.bodyKey,
        payload: {},
        payload_schema_version: 1,
        deduplication_key: `admin-account-action:${write.actionId}`,
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
        category: 'admin',
        event_type: 'moderation.account-action.v1',
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: write.adminUserId,
        subject_type: 'user',
        subject_id: write.targetUserId,
        result_code: write.action,
        metadata_schema_version: 1,
        metadata: { actionType: write.action, reasonCode: code },
        request_id: write.requestId,
        command_id: write.commandId,
        occurred_at: now,
      })
      .execute();
    await database
      .insertInto('moderation.moderation_actions')
      .values({
        id: write.actionId,
        action_type: write.action,
        actor_type: 'admin',
        actor_admin_id: write.adminUserId,
        target_user_id: write.targetUserId,
        target_photo_id: null,
        target_pair_low_user_id: null,
        target_pair_high_user_id: null,
        source_report_id: null,
        restriction_episode_id: restrictionEpisodeId,
        audit_log_id: write.auditId,
        notification_id: write.notificationId,
        command_id: write.commandId,
        request_id: write.requestId,
        request_digest: write.requestDigest,
        reason_code: code,
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
      aggregateId: write.targetUserId,
      eventType: 'identity.account-state-changed.v1',
      payload: {
        userId: write.targetUserId,
        previousState: account.state,
        nextState: state,
        reasonCode: code,
        accountVersion: updated.version,
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
        actionType: write.action,
        targetUserId: write.targetUserId,
        accountVersion: updated.version,
      },
      occurredAt: now,
      requestId: write.requestId,
      commandId: write.commandId,
    });

    return {
      actionId: write.actionId,
      targetUserId: write.targetUserId,
      previousState: account.state,
      nextState: state,
      accountVersion: updated.version,
    };
  }
}

/** Production composition: the account transition and its AdminActionLog share one commit. */
export class PostgresAccountModerationWorkflow extends AccountModerationWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresAccountModerationStore(),
      new SystemIdGenerator(),
    );
  }
}
