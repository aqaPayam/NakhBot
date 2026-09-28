import { sql } from 'kysely';

import {
  InternalBlockWorkflow,
  type InternalBlockResult,
  type InternalBlockWorkflowStore,
  type InternalBlockWrite,
} from '@nakh/application';
import { ApplicationError, canTransitionPairState } from '@nakh/domain';

import { PostgresAdminCommandStore } from './admin-command-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { lockUserPair } from './pair-lock.js';

function unavailable(): ApplicationError {
  return new ApplicationError(
    'moderation_state_invalid',
    'error.moderation.internal_block_unavailable',
    409,
  );
}

function versionConflict(): ApplicationError {
  return new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
}

async function databaseTime(database: NakhDatabase): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  return result.rows[0]!.now;
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

export class PostgresInternalBlockStore implements InternalBlockWorkflowStore<NakhDatabase> {
  public async change(
    database: NakhDatabase,
    write: InternalBlockWrite,
  ): Promise<InternalBlockResult> {
    // Existing interaction/match writers acquire this canonical lock first. Sharing their order
    // makes a block race serialize instead of deadlocking with a Like or Match transaction.
    const pairIdentity = await lockUserPair(database, write.userLowId, write.userHighId);
    if (pairIdentity.userLowId !== write.userLowId || pairIdentity.userHighId !== write.userHighId)
      throw unavailable();

    const accounts = await database
      .selectFrom('identity.accounts')
      .select('user_id')
      .where('user_id', 'in', [write.userLowId, write.userHighId])
      .orderBy('user_id')
      .forUpdate()
      .execute();
    if (accounts.length !== 2) throw unavailable();

    const pair = await database
      .selectFrom('interaction.user_pair_states')
      .select(['state', 'version'])
      .where('user_low_id', '=', write.userLowId)
      .where('user_high_id', '=', write.userHighId)
      .forUpdate()
      .executeTakeFirst();
    if ((pair?.version ?? 1) !== write.expectedPairVersion) throw versionConflict();
    if (
      write.action === 'create'
        ? !canTransitionPairState(pair?.state, 'blocked')
        : !canTransitionPairState(pair?.state, undefined, true)
    )
      throw unavailable();

    const match = await database
      .selectFrom('matching.matches')
      .select(['id', 'status', 'version'])
      .where('user_low_id', '=', write.userLowId)
      .where('user_high_id', '=', write.userHighId)
      .forUpdate()
      .executeTakeFirst();
    const session =
      match === undefined
        ? undefined
        : await database
            .selectFrom('chat.chat_sessions')
            .select(['id', 'status', 'version'])
            .where('match_id', '=', match.id)
            .forUpdate()
            .executeTakeFirst();
    const likes = await database
      .selectFrom('interaction.likes')
      .select(['id', 'status'])
      .where((expression) =>
        expression.or([
          expression.and([
            expression('sender_user_id', '=', write.userLowId),
            expression('receiver_user_id', '=', write.userHighId),
          ]),
          expression.and([
            expression('sender_user_id', '=', write.userHighId),
            expression('receiver_user_id', '=', write.userLowId),
          ]),
        ]),
      )
      .orderBy('id')
      .forUpdate()
      .execute();
    const likeIds = likes.map(({ id }) => id);
    const unlocks = await database
      .selectFrom('interaction.feature_unlocks')
      .select('id')
      .where('status', '=', 'active')
      .where((expression) =>
        expression.or([
          expression('like_id', 'in', likeIds),
          match === undefined ? expression.val(false) : expression('match_id', '=', match.id),
        ]),
      )
      .orderBy('id')
      .forUpdate()
      .execute();

    const occurredAt = await databaseTime(database);
    let pairVersion: number | null;
    let closedMatchId: string | null = null;
    let closedChatSessionId: string | null = null;
    let closedLikeCount = 0;
    let revokedUnlockCount = 0;
    if (write.action === 'create') {
      if (pair === undefined) {
        await database
          .insertInto('interaction.user_pair_states')
          .values({
            user_low_id: write.userLowId,
            user_high_id: write.userHighId,
            state: 'blocked',
            reason_code: 'admin_internal_block',
            changed_at: occurredAt,
          })
          .execute();
        pairVersion = 1;
      } else {
        pairVersion = pair.version + 1;
        await database
          .updateTable('interaction.user_pair_states')
          .set({
            state: 'blocked',
            reason_code: 'admin_internal_block',
            changed_at: occurredAt,
            version: pairVersion,
          })
          .where('user_low_id', '=', write.userLowId)
          .where('user_high_id', '=', write.userHighId)
          .where('version', '=', write.expectedPairVersion)
          .executeTakeFirstOrThrow();
      }
      if (match?.status === 'active') {
        closedMatchId = match.id;
        await database
          .updateTable('matching.matches')
          .set({ status: 'closed', closed_at: occurredAt, version: match.version + 1 })
          .where('id', '=', match.id)
          .executeTakeFirstOrThrow();
      }
      if (session?.status === 'active') {
        closedChatSessionId = session.id;
        await database
          .updateTable('chat.chat_sessions')
          .set({
            status: 'closed',
            closed_at: occurredAt,
            closed_reason: 'internal_block',
            version: session.version + 1,
          })
          .where('id', '=', session.id)
          .executeTakeFirstOrThrow();
      }
      const activeLikeIds = likes.filter(({ status }) => status === 'active').map(({ id }) => id);
      if (activeLikeIds.length > 0) {
        const closed = await database
          .updateTable('interaction.likes')
          .set((expression) => ({
            status: 'cancelled_by_system',
            closed_at: occurredAt,
            version: expression('version', '+', 1),
          }))
          .where('id', 'in', activeLikeIds)
          .where('status', '=', 'active')
          .executeTakeFirst();
        closedLikeCount = Number(closed.numUpdatedRows);
      }
      if (unlocks.length > 0) {
        const revoked = await database
          .updateTable('interaction.feature_unlocks')
          .set((expression) => ({
            status: 'revoked',
            revoked_at: occurredAt,
            revoked_reason: 'internal_block',
            revoked_by_admin_id: write.adminUserId,
            version: expression('version', '+', 1),
          }))
          .where(
            'id',
            'in',
            unlocks.map(({ id }) => id),
          )
          .where('status', '=', 'active')
          .executeTakeFirst();
        revokedUnlockCount = Number(revoked.numUpdatedRows);
      }
    } else {
      await database
        .deleteFrom('interaction.user_pair_states')
        .where('user_low_id', '=', write.userLowId)
        .where('user_high_id', '=', write.userHighId)
        .where('state', '=', 'blocked')
        .where('version', '=', write.expectedPairVersion)
        .executeTakeFirstOrThrow();
      pairVersion = null;
    }

    const actionType =
      write.action === 'create' ? 'create_internal_block' : 'remove_internal_block';
    const reasonCode = `admin_internal_block_${write.action}d`;
    await database
      .insertInto('platform.audit_logs')
      .values({
        id: write.auditId,
        category: 'admin',
        event_type: 'moderation.internal-block-changed.v1',
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: write.adminUserId,
        subject_type: 'user_pair',
        subject_id: write.pairTargetId,
        result_code: actionType,
        metadata_schema_version: 1,
        metadata: {
          actionType,
          reasonCode,
          closedMatch: closedMatchId !== null,
          closedChat: closedChatSessionId !== null,
          closedLikeCount,
          revokedUnlockCount,
        },
        request_id: write.requestId,
        command_id: write.commandId,
        occurred_at: occurredAt,
      })
      .execute();
    await database
      .insertInto('moderation.moderation_actions')
      .values({
        id: write.actionId,
        action_type: actionType,
        actor_type: 'admin',
        actor_admin_id: write.adminUserId,
        target_user_id: null,
        target_photo_id: null,
        target_pair_low_user_id: write.userLowId,
        target_pair_high_user_id: write.userHighId,
        source_report_id: null,
        restriction_episode_id: null,
        audit_log_id: write.auditId,
        notification_id: null,
        command_id: write.commandId,
        request_id: write.requestId,
        request_digest: write.requestDigest,
        reason_code: reasonCode,
        occurred_at: occurredAt,
      })
      .execute();
    const result: InternalBlockResult = {
      actionId: write.actionId,
      userLowId: write.userLowId,
      userHighId: write.userHighId,
      previousState: pair?.state,
      nextState: write.action === 'create' ? 'blocked' : undefined,
      pairVersion,
      closedMatchId,
      closedChatSessionId,
      closedLikeCount,
      revokedUnlockCount,
    };
    await insertEvent(database, {
      id: write.blockEventId,
      aggregateType: 'user_pair',
      aggregateId: write.pairTargetId,
      eventType: 'moderation.internal-block-changed.v1',
      payload: {
        actionId: write.actionId,
        action: write.action,
        pairTargetId: write.pairTargetId,
        pairVersion,
        closedMatchId,
        closedChatSessionId,
        closedLikeCount,
        revokedUnlockCount,
      },
      occurredAt,
      requestId: write.requestId,
      commandId: write.commandId,
    });
    await insertEvent(database, {
      id: write.actionEventId,
      aggregateType: 'moderation_action',
      aggregateId: write.actionId,
      eventType: 'moderation.action-recorded.v1',
      payload: { actionId: write.actionId, actionType, pairTargetId: write.pairTargetId },
      occurredAt,
      requestId: write.requestId,
      commandId: write.commandId,
    });
    return result;
  }
}

/** Production composition: pair closure and the immutable admin attempt share one commit. */
export class PostgresInternalBlockWorkflow extends InternalBlockWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresInternalBlockStore(),
      new SystemIdGenerator(),
    );
  }
}
