import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { CreateDirectNakhWrite, DirectNakhStore } from '@nakh/application';
import type { CreateDirectNakhCommand, DirectNakhResult } from '@nakh/contracts';
import {
  ApplicationError,
  calculateCreditBalance,
  DELIVERED_NAKH_LIFETIME_MS,
  NAKH_CREDIT_COST,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { insertNotification } from './notification-store.js';
import { lockUserPair } from './pair-lock.js';

function commandHash(command: CreateDirectNakhCommand): string {
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

function ledgerKey(command: CreateDirectNakhCommand): string {
  return `nakh-spend:${createHash('sha256')
    .update(`${command.actor.userId}|${command.idempotencyKey}`)
    .digest('hex')}`;
}

function replayResult(value: Readonly<Record<string, unknown>>): DirectNakhResult {
  return {
    nakhId: String(value.nakhId),
    status: 'sent',
    sentAt: String(value.sentAt),
    expiresAt: String(value.expiresAt),
    replayed: true,
  };
}

function unavailable(): never {
  throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);
}

export class PostgresDirectNakhStore implements DirectNakhStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async createDirect(write: CreateDirectNakhWrite): Promise<DirectNakhResult> {
    const { command } = write;
    const senderUserId = command.actor.userId;
    const receiverUserId = command.data.targetUserId;
    const requestHash = commandHash(command);
    return this.database.transaction().execute(async (transaction) => {
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

      const pair = await lockUserPair(transaction, senderUserId, receiverUserId);
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
        unavailable();

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
          .where('receiver_user_id', '=', receiverUserId)
          .executeTakeFirst(),
        transaction
          .selectFrom('interaction.likes')
          .select('id')
          .where((expression) =>
            expression.or([
              expression.and([
                expression('sender_user_id', '=', senderUserId),
                expression('receiver_user_id', '=', receiverUserId),
              ]),
              expression.and([
                expression('sender_user_id', '=', receiverUserId),
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
                expression('receiver_user_id', '=', receiverUserId),
              ]),
              expression.and([
                expression('sender_user_id', '=', receiverUserId),
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
        unavailable();

      const account = await transaction
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (account === undefined)
        throw new ApplicationError('not_found', 'error.billing.credit_account_not_found', 404);
      const balanceBefore = BigInt(account.balance);
      const balanceAfter = calculateCreditBalance({
        transactionType: 'spend_nakh',
        balanceBefore,
        amount: -NAKH_CREDIT_COST,
      });
      const accountVersion = account.version + 1;
      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const sentAt = time.rows[0]!.now;
      const expiresAt = new Date(sentAt.getTime() + DELIVERED_NAKH_LIFETIME_MS);

      await transaction
        .insertInto('nakh.nakh_flows')
        .values({
          id: write.flowId,
          sender_user_id: senderUserId,
          receiver_user_id: receiverUserId,
          created_at: sentAt,
        })
        .execute();
      await transaction
        .insertInto('discovery.explore_consumptions')
        .values({
          viewer_user_id: senderUserId,
          target_user_id: receiverUserId,
          reason: 'nakh_flow',
          consumed_at: sentAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      await transaction
        .insertInto('nakh.nakhes')
        .values({
          id: write.nakhId,
          nakh_flow_id: write.flowId,
          sender_user_id: senderUserId,
          receiver_user_id: receiverUserId,
          text: command.data.text,
          funding_type: 'credits',
          credit_transaction_id: write.creditTransactionId,
          payment_record_id: null,
          sent_at: sentAt,
          expires_at: expiresAt,
          seen_at: null,
          accepted_at: null,
          rejected_at: null,
          expired_at: null,
          closed_at: null,
        })
        .execute();
      await transaction
        .insertInto('nakh.nakh_status_history')
        .values({
          id: write.historyId,
          nakh_id: write.nakhId,
          nakh_version: 1,
          from_status: null,
          to_status: 'sent',
          reason_code: 'credit_funded',
          changed_by_user_id: senderUserId,
          request_id: command.requestId,
          changed_at: sentAt,
        })
        .execute();
      await transaction
        .insertInto('billing.credit_transactions')
        .values({
          id: write.creditTransactionId,
          credit_account_id: senderUserId,
          user_id: senderUserId,
          account_version: accountVersion,
          transaction_type: 'spend_nakh',
          amount: (-NAKH_CREDIT_COST).toString(),
          balance_before: balanceBefore.toString(),
          balance_after: balanceAfter.toString(),
          payment_record_id: null,
          pending_payment_id: null,
          feature_unlock_id: null,
          nakh_id: write.nakhId,
          idempotency_key: ledgerKey(command),
          correlation_id: command.requestId,
          created_at: sentAt,
        })
        .execute();
      await transaction
        .updateTable('billing.credit_accounts')
        .set({
          balance: balanceAfter.toString(),
          version: accountVersion,
          updated_at: sentAt,
        })
        .where('user_id', '=', senderUserId)
        .where('version', '=', account.version)
        .executeTakeFirstOrThrow();

      await insertNotification(transaction, {
        userId: receiverUserId,
        type: 'nakh_received',
        titleKey: 'notification.nakh_received.title',
        bodyKey: 'notification.nakh_received.body',
        payload: { nakhId: write.nakhId },
        deduplicationKey: `nakh-received:${write.nakhId}`,
        correlationId: command.requestId,
        causationId: command.commandId,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values([
          {
            id: write.flowEventId,
            aggregate_type: 'nakh_flow',
            aggregate_id: write.flowId,
            event_type: 'nakh.flow-created.v1',
            schema_version: 1,
            payload: { flowId: write.flowId, senderUserId, receiverUserId },
            occurred_at: sentAt,
            available_at: sentAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          },
          {
            id: write.deliveredEventId,
            aggregate_type: 'nakh',
            aggregate_id: write.nakhId,
            event_type: 'nakh.delivered.v1',
            schema_version: 1,
            payload: { nakhId: write.nakhId, receiverUserId },
            occurred_at: sentAt,
            available_at: sentAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          },
        ])
        .execute();
      const result: DirectNakhResult = {
        nakhId: write.nakhId,
        status: 'sent',
        sentAt: sentAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: sentAt })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }
}
