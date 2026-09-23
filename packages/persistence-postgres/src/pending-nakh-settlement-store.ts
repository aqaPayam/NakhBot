import { sql } from 'kysely';

import type {
  PendingNakhSettlementStepResult,
  PendingNakhSettlementStore,
  PendingNakhSettlementWrite,
} from '@nakh/application';
import {
  ApplicationError,
  calculateCreditBalance,
  DELIVERED_NAKH_LIFETIME_MS,
  isDelayedNakhDeliveryEligible,
  NAKH_CREDIT_COST,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { insertNotification } from './notification-store.js';
import { lockUserPair } from './pair-lock.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validate(write: PendingNakhSettlementWrite): void {
  if (
    !UUID.test(write.senderUserId) ||
    !UUID.test(write.triggerCreditTransactionId) ||
    !UUID.test(write.causationId) ||
    !UUID.test(write.nakhId) ||
    !UUID.test(write.historyId) ||
    !UUID.test(write.creditTransactionId) ||
    !UUID.test(write.terminalEventId)
  )
    throw new ApplicationError('invalid_request', 'error.nakh.settlement_invalid', 400);
}

/** Settles exactly the oldest sender row while holding the canonical sender and pair locks. */
export class PostgresPendingNakhSettlementStore implements PendingNakhSettlementStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async settleOldest(
    write: PendingNakhSettlementWrite,
  ): Promise<PendingNakhSettlementStepResult> {
    validate(write);
    return this.database.transaction().execute(async (transaction) => {
      const counter = await transaction
        .selectFrom('platform.user_counters')
        .select(['user_id', 'pending_nakh_count'])
        .where('user_id', '=', write.senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (counter === undefined)
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const trigger = await transaction
        .selectFrom('billing.credit_transactions')
        .select(['user_id', 'amount'])
        .where('id', '=', write.triggerCreditTransactionId)
        .where('user_id', '=', write.senderUserId)
        .executeTakeFirst();
      if (trigger === undefined || BigInt(trigger.amount) <= 0n)
        throw new ApplicationError('invalid_request', 'error.nakh.settlement_invalid', 400);

      const locator = await transaction
        .selectFrom('nakh.pending_nakhes as pending')
        .innerJoin('nakh.nakh_flows as flow', 'flow.id', 'pending.nakh_flow_id')
        .innerJoin('billing.pending_payments as intent', 'intent.id', 'pending.pending_payment_id')
        .select(['pending.id as pending_nakh_id', 'pending.nakh_flow_id', 'flow.receiver_user_id'])
        .where('pending.sender_user_id', '=', write.senderUserId)
        .where('pending.status', '=', 'pending_payment')
        .where('intent.status', '=', 'pending')
        .orderBy('pending.created_at', 'asc')
        .orderBy('pending.id', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (locator === undefined) return { outcome: 'idle' };

      const pair = await lockUserPair(transaction, write.senderUserId, locator.receiver_user_id);
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
      const pairState = await transaction
        .selectFrom('interaction.user_pair_states')
        .select('state')
        .where('user_low_id', '=', pair.userLowId)
        .where('user_high_id', '=', pair.userHighId)
        .executeTakeFirst();
      const flow = await transaction
        .selectFrom('nakh.nakh_flows')
        .select(['id', 'sender_user_id', 'receiver_user_id'])
        .where('id', '=', locator.nakh_flow_id)
        .where('sender_user_id', '=', write.senderUserId)
        .where('receiver_user_id', '=', locator.receiver_user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pending = await transaction
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('id', '=', locator.pending_nakh_id)
        .where('nakh_flow_id', '=', flow.id)
        .where('sender_user_id', '=', write.senderUserId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const intent = await transaction
        .selectFrom('billing.pending_payments')
        .select(['id', 'user_id', 'reason', 'target_type', 'target_id', 'status', 'version'])
        .where('id', '=', pending.pending_payment_id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (
        intent.user_id !== write.senderUserId ||
        intent.reason !== 'send_nakh' ||
        intent.target_type !== 'pending_nakh' ||
        intent.target_id !== pending.id
      )
        throw new ApplicationError('invalid_request', 'error.nakh.settlement_invalid', 409);
      if (intent.status === 'paid')
        return { outcome: 'stop_external_funding', pendingNakhId: pending.id };

      const time = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
        transaction,
      );
      const now = time.rows[0]!.now;
      const expired = pending.expires_at <= now;
      const sender = users.find((user) => user.id === flow.sender_user_id);
      const receiver = users.find((user) => user.id === flow.receiver_user_id);
      const eligible =
        !expired &&
        intent.status === 'pending' &&
        counter.pending_nakh_count > 0 &&
        sender !== undefined &&
        receiver !== undefined &&
        isDelayedNakhDeliveryEligible({
          sender: {
            accountState: sender.state,
            profileCompletion: sender.completion_status,
            visibilityEnabled: sender.visibility_enabled,
          },
          receiver: {
            accountState: receiver.state,
            profileCompletion: receiver.completion_status,
            visibilityEnabled: receiver.visibility_enabled,
          },
          ...(pairState === undefined ? {} : { pairState: pairState.state }),
        });

      if (!eligible) {
        const pendingStatus = expired ? 'expired' : 'closed_by_system';
        if (intent.status === 'pending')
          await transaction
            .updateTable('billing.pending_payments')
            .set({
              status: expired ? 'expired' : 'cancelled',
              resolved_at: now,
              version: sql<number>`version + 1`,
            })
            .where('id', '=', intent.id)
            .where('status', '=', 'pending')
            .where('version', '=', intent.version)
            .executeTakeFirstOrThrow();
        await transaction
          .updateTable('nakh.pending_nakhes')
          .set({
            status: pendingStatus,
            ...(expired ? { expired_at: now } : { closed_at: now }),
            version: sql<number>`version + 1`,
          })
          .where('id', '=', pending.id)
          .where('status', '=', 'pending_payment')
          .where('version', '=', pending.version)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('platform.user_counters')
          .set({
            pending_nakh_count: sql<number>`pending_nakh_count - 1`,
            version: sql<number>`version + 1`,
            updated_at: now,
          })
          .where('user_id', '=', write.senderUserId)
          .where('pending_nakh_count', '>', 0)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.terminalEventId,
            aggregate_type: 'pending_nakh',
            aggregate_id: pending.id,
            event_type: 'nakh.status-changed.v1',
            schema_version: 1,
            payload: { pendingNakhId: pending.id, status: pendingStatus },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: write.triggerCreditTransactionId,
            causation_id: write.causationId,
          })
          .execute();
        return { outcome: 'closed_and_continue', pendingNakhId: pending.id };
      }

      const account = await transaction
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', write.senderUserId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const balanceBefore = BigInt(account.balance);
      if (balanceBefore < NAKH_CREDIT_COST)
        return { outcome: 'stop_insufficient_credits', pendingNakhId: pending.id };
      const balanceAfter = calculateCreditBalance({
        transactionType: 'spend_nakh',
        balanceBefore,
        amount: -NAKH_CREDIT_COST,
      });
      const accountVersion = account.version + 1;
      const expiresAt = new Date(now.getTime() + DELIVERED_NAKH_LIFETIME_MS);

      await transaction
        .insertInto('nakh.nakhes')
        .values({
          id: write.nakhId,
          nakh_flow_id: flow.id,
          sender_user_id: flow.sender_user_id,
          receiver_user_id: flow.receiver_user_id,
          text: pending.text,
          funding_type: 'credits',
          credit_transaction_id: write.creditTransactionId,
          payment_record_id: null,
          sent_at: now,
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
          reason_code: 'credit_settlement',
          changed_by_user_id: write.senderUserId,
          request_id: write.causationId,
          changed_at: now,
        })
        .execute();
      await transaction
        .insertInto('billing.credit_transactions')
        .values({
          id: write.creditTransactionId,
          credit_account_id: write.senderUserId,
          user_id: write.senderUserId,
          account_version: accountVersion,
          transaction_type: 'spend_nakh',
          amount: (-NAKH_CREDIT_COST).toString(),
          balance_before: balanceBefore.toString(),
          balance_after: balanceAfter.toString(),
          payment_record_id: null,
          pending_payment_id: pending.pending_payment_id,
          feature_unlock_id: null,
          nakh_id: write.nakhId,
          idempotency_key: `pending-nakh-settlement:${pending.id}`,
          correlation_id: write.triggerCreditTransactionId,
          created_at: now,
        })
        .execute();
      await transaction
        .updateTable('billing.credit_accounts')
        .set({ balance: balanceAfter.toString(), version: accountVersion, updated_at: now })
        .where('user_id', '=', write.senderUserId)
        .where('version', '=', account.version)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.pending_payments')
        .set({ status: 'paid', resolved_at: now, version: sql<number>`version + 1` })
        .where('id', '=', intent.id)
        .where('status', '=', 'pending')
        .where('version', '=', intent.version)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('nakh.pending_nakhes')
        .set({ status: 'paid_and_sent', paid_at: now, version: sql<number>`version + 1` })
        .where('id', '=', pending.id)
        .where('status', '=', 'pending_payment')
        .where('version', '=', pending.version)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.user_counters')
        .set({
          pending_nakh_count: sql<number>`pending_nakh_count - 1`,
          version: sql<number>`version + 1`,
          updated_at: now,
        })
        .where('user_id', '=', write.senderUserId)
        .where('pending_nakh_count', '>', 0)
        .executeTakeFirstOrThrow();
      await insertNotification(transaction, {
        userId: flow.receiver_user_id,
        type: 'nakh_received',
        titleKey: 'notification.nakh_received.title',
        bodyKey: 'notification.nakh_received.body',
        payload: { nakhId: write.nakhId },
        deduplicationKey: `nakh-received:${write.nakhId}`,
        correlationId: write.triggerCreditTransactionId,
        causationId: write.causationId,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.terminalEventId,
          aggregate_type: 'nakh',
          aggregate_id: write.nakhId,
          event_type: 'nakh.delivered.v1',
          schema_version: 1,
          payload: { nakhId: write.nakhId, receiverUserId: flow.receiver_user_id },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.triggerCreditTransactionId,
          causation_id: write.causationId,
        })
        .execute();
      return { outcome: 'delivered_and_continue', pendingNakhId: pending.id };
    });
  }
}
