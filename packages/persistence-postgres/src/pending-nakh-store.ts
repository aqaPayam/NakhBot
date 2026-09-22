import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { CreatePendingNakhWrite, PendingNakhStore } from '@nakh/application';
import type { CreatePendingNakhCommand, PendingNakhResult } from '@nakh/contracts';
import {
  ApplicationError,
  MAX_PENDING_NAKHES_PER_SENDER,
  NAKH_STARS_COST,
  PENDING_NAKH_LIFETIME_MS,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

function commandHash(command: CreatePendingNakhCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: command.schemaVersion,
        actor: command.actor,
        data: command.data,
      }),
    )
    .digest('hex');
}

function replayResult(value: Readonly<Record<string, unknown>>): PendingNakhResult {
  return {
    pendingNakhId: String(value.pendingNakhId),
    status: String(value.status) as PendingNakhResult['status'],
    expiresAt: String(value.expiresAt),
    version: Number(value.version),
    replayed: true,
  };
}

export class PostgresPendingNakhStore implements PendingNakhStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async createPending(write: CreatePendingNakhWrite): Promise<PendingNakhResult> {
    const { command } = write;
    const senderUserId = command.actor.userId;
    const targetUserId = command.data.targetUserId;
    const requestHash = commandHash(command);
    return this.database.transaction().execute(async (transaction) => {
      const counter = await transaction
        .selectFrom('platform.user_counters')
        .selectAll()
        .where('user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (counter === undefined)
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: senderUserId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(Date.parse(command.occurredAt) + 86_400_000),
          created_at: new Date(command.occurredAt),
          updated_at: new Date(command.occurredAt),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', senderUserId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (existing === undefined || existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return replayResult(existing.response_json);
      }

      const pair = await lockUserPair(transaction, senderUserId, targetUserId);
      const users = await transaction
        .selectFrom('identity.users as user')
        .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
        .innerJoin('identity.user_settings as settings', 'settings.user_id', 'user.id')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'user.id')
        .select([
          'user.id',
          'account.state',
          'settings.visibility_enabled',
          'profile.completion_status',
        ])
        .where('user.id', 'in', [pair.userLowId, pair.userHighId])
        .orderBy('user.id')
        .forUpdate()
        .execute();
      if (
        users.length !== 2 ||
        users.some(
          (user) =>
            user.state !== 'active' ||
            user.completion_status !== 'complete' ||
            !user.visibility_enabled,
        )
      )
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const [pairState, existingFlow, incompatibleLike, incompatibleRejection] = await Promise.all([
        transaction
          .selectFrom('interaction.user_pair_states')
          .select('state')
          .where('user_low_id', '=', pair.userLowId)
          .where('user_high_id', '=', pair.userHighId)
          .executeTakeFirst(),
        transaction
          .selectFrom('nakh.nakh_flows')
          .select('id')
          .where('sender_user_id', '=', senderUserId)
          .where('receiver_user_id', '=', targetUserId)
          .executeTakeFirst(),
        transaction
          .selectFrom('interaction.likes')
          .select('id')
          .where((expression) =>
            expression.or([
              expression.and([
                expression('sender_user_id', '=', senderUserId),
                expression('receiver_user_id', '=', targetUserId),
              ]),
              expression.and([
                expression('sender_user_id', '=', targetUserId),
                expression('receiver_user_id', '=', senderUserId),
              ]),
            ]),
          )
          .executeTakeFirst(),
        transaction
          .selectFrom('interaction.not_interested')
          .select('id')
          .where((expression) =>
            expression.or([
              expression.and([
                expression('sender_user_id', '=', senderUserId),
                expression('receiver_user_id', '=', targetUserId),
              ]),
              expression.and([
                expression('sender_user_id', '=', targetUserId),
                expression('receiver_user_id', '=', senderUserId),
              ]),
            ]),
          )
          .executeTakeFirst(),
      ]);
      if (existingFlow !== undefined)
        throw new ApplicationError('nakh_flow_exists', 'error.nakh.flow_exists', 409);
      if (
        pairState !== undefined ||
        incompatibleLike !== undefined ||
        incompatibleRejection !== undefined
      )
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);
      if (counter.pending_nakh_count >= MAX_PENDING_NAKHES_PER_SENDER)
        throw new ApplicationError('nakh_quota_reached', 'error.nakh.quota_reached', 409);

      const time = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
        transaction,
      );
      const now = time.rows[0]!.now;
      const expiresAt = new Date(now.getTime() + PENDING_NAKH_LIFETIME_MS);
      await transaction
        .insertInto('nakh.nakh_flows')
        .values({
          id: write.flowId,
          sender_user_id: senderUserId,
          receiver_user_id: targetUserId,
          created_at: now,
        })
        .execute();
      await transaction
        .insertInto('discovery.explore_consumptions')
        .values({
          viewer_user_id: senderUserId,
          target_user_id: targetUserId,
          reason: 'nakh_flow',
          consumed_at: now,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      await transaction
        .insertInto('billing.pending_payments')
        .values({
          id: write.pendingPaymentId,
          user_id: senderUserId,
          reason: 'send_nakh',
          target_type: 'pending_nakh',
          target_id: write.pendingNakhId,
          funding_type: 'telegram_stars',
          required_credits: null,
          required_stars: NAKH_STARS_COST.toString(),
          package_code_snapshot: null,
          package_credit_amount_snapshot: null,
          idempotency_key: `nakh-payment:${write.pendingNakhId}`,
          request_hash: requestHash,
          created_at: now,
          expires_at: expiresAt,
          resolved_at: null,
        })
        .execute();
      const pending = await transaction
        .insertInto('nakh.pending_nakhes')
        .values({
          id: write.pendingNakhId,
          nakh_flow_id: write.flowId,
          sender_user_id: senderUserId,
          text: command.data.text,
          pending_payment_id: write.pendingPaymentId,
          auto_settle_authorized_at: now,
          authorization_source: 'explore',
          authorized_at: now,
          created_at: now,
          expires_at: expiresAt,
          paid_at: null,
          cancelled_at: null,
          expired_at: null,
          closed_at: null,
          cancel_resolution: null,
          last_reminder_at: null,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
        })
        .returning(['id', 'status', 'expires_at', 'version'])
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.user_counters')
        .set({
          pending_nakh_count: sql<number>`pending_nakh_count + 1`,
          version: sql<number>`version + 1`,
          updated_at: now,
        })
        .where('user_id', '=', senderUserId)
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto('platform.outbox_events')
        .values([
          {
            id: write.flowEventId,
            aggregate_type: 'nakh_flow',
            aggregate_id: write.flowId,
            event_type: 'nakh.flow-created.v1',
            schema_version: 1,
            payload: { flowId: write.flowId, senderUserId, receiverUserId: targetUserId },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          },
          {
            id: write.pendingEventId,
            aggregate_type: 'pending_nakh',
            aggregate_id: write.pendingNakhId,
            event_type: 'nakh.pending-created.v1',
            schema_version: 1,
            payload: { pendingNakhId: write.pendingNakhId, senderUserId },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          },
        ])
        .execute();
      const result: PendingNakhResult = {
        pendingNakhId: pending.id,
        status: pending.status,
        expiresAt: pending.expires_at.toISOString(),
        version: pending.version,
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: now })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }
}
