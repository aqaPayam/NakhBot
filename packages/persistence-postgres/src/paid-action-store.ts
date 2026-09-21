import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  PaidActionTarget,
  PaidActionStore,
  SpendCreditsForPaidActionWrite,
  StoredFeatureUnlock,
} from '@nakh/application';
import { ApplicationError, calculateCreditBalance, getPaidActionPrice } from '@nakh/domain';

import { actionableLikedByFrom } from './liked-by-store.js';
import { lockUserPair } from './pair-lock.js';
import type { NakhDatabase } from './database.js';

function ledgerKey(write: SpendCreditsForPaidActionWrite): string {
  return `unlock:${createHash('sha256')
    .update(`${write.userId}|${write.idempotencyKey}`)
    .digest('hex')}`;
}

function result(
  row: Readonly<{
    id: string;
    feature_type: 'liked_by_profile_unlock' | 'chat_unlock';
    unlocked_at: Date;
  }>,
  replayed: boolean,
): StoredFeatureUnlock {
  return {
    id: row.id,
    featureType: row.feature_type,
    unlockedAt: row.unlocked_at,
    replayed,
  };
}

function unavailable(): never {
  throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
}

/** Locks the product scope and revalidates the canonical effective-access prerequisites. */
export async function lockAndValidatePaidActionTarget(
  database: NakhDatabase,
  userId: string,
  target: PaidActionTarget,
): Promise<void> {
  if (target.type === 'like') {
    const identity = await database
      .selectFrom('interaction.likes')
      .select(['sender_user_id', 'receiver_user_id'])
      .where('id', '=', target.targetId)
      .executeTakeFirst();
    if (identity === undefined || identity.receiver_user_id !== userId) unavailable();
    await lockUserPair(database, identity.sender_user_id, identity.receiver_user_id);
    const like = await database
      .selectFrom('interaction.likes')
      .select('status')
      .where('id', '=', target.targetId)
      .where('receiver_user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    const receiver = await database
      .selectFrom('identity.accounts as account')
      .innerJoin('identity.user_settings as settings', 'settings.user_id', 'account.user_id')
      .innerJoin('profile.profiles as profile', 'profile.user_id', 'account.user_id')
      .select(['account.state', 'settings.visibility_enabled', 'profile.completion_status'])
      .where('account.user_id', '=', userId)
      .executeTakeFirst();
    const actionable = await sql<{ id: string }>`
      SELECT incoming.id ${actionableLikedByFrom(userId)}
      AND incoming.id = ${target.targetId}::uuid
    `.execute(database);
    if (
      like?.status !== 'active' ||
      receiver?.state !== 'active' ||
      !receiver.visibility_enabled ||
      receiver.completion_status !== 'complete' ||
      actionable.rows.length !== 1
    )
      unavailable();
    return;
  }

  const identity = await database
    .selectFrom('matching.matches')
    .select(['user_low_id', 'user_high_id'])
    .where('id', '=', target.targetId)
    .executeTakeFirst();
  if (identity === undefined) unavailable();
  await lockUserPair(database, identity.user_low_id, identity.user_high_id);
  const match = await database
    .selectFrom('matching.matches as match')
    .innerJoin('matching.match_participants as participant', 'participant.match_id', 'match.id')
    .innerJoin('chat.chat_sessions as chat', 'chat.match_id', 'match.id')
    .innerJoin('interaction.user_pair_states as pair', (join) =>
      join
        .onRef('pair.user_low_id', '=', 'match.user_low_id')
        .onRef('pair.user_high_id', '=', 'match.user_high_id'),
    )
    .innerJoin('identity.accounts as account', 'account.user_id', 'participant.user_id')
    .select('match.id')
    .where('match.id', '=', target.targetId)
    .where('participant.user_id', '=', userId)
    .where('match.status', '=', 'active')
    .where('chat.status', '=', 'active')
    .where('pair.state', '=', 'matched')
    .where('account.state', '=', 'active')
    .forUpdate()
    .executeTakeFirst();
  if (match === undefined) unavailable();
}

export class PostgresPaidActionStore implements PaidActionStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async spendCredits(write: SpendCreditsForPaidActionWrite): Promise<StoredFeatureUnlock> {
    return this.database.transaction().execute(async (transaction) => {
      const featureType = write.target.type === 'like' ? 'liked_by_profile_unlock' : 'chat_unlock';
      await lockAndValidatePaidActionTarget(transaction, write.userId, write.target);

      const existing = await transaction
        .selectFrom('interaction.feature_unlocks')
        .select(['id', 'feature_type', 'unlocked_at'])
        .where(write.target.type === 'like' ? 'like_id' : 'match_id', '=', write.target.targetId)
        .executeTakeFirst();
      if (existing !== undefined) return result(existing, true);

      const account = await transaction
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', write.userId)
        .forUpdate()
        .executeTakeFirst();
      if (account === undefined)
        throw new ApplicationError('not_found', 'error.billing.credit_account_not_found', 404);

      const idempotencyKey = ledgerKey(write);
      const reusedKey = await transaction
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (reusedKey !== undefined)
        throw new ApplicationError(
          'idempotency_conflict',
          'error.billing.idempotency_conflict',
          409,
        );

      const price = getPaidActionPrice(
        write.target.type === 'like' ? 'unlock_liked_by_profile' : 'unlock_chat',
        'credits',
      );
      const balanceBefore = BigInt(account.balance);
      const balanceAfter = calculateCreditBalance({
        transactionType:
          write.target.type === 'like' ? 'spend_liked_by_unlock' : 'spend_chat_unlock',
        balanceBefore,
        amount: -price,
      });
      const accountVersion = account.version + 1;

      const unlock = await transaction
        .insertInto('interaction.feature_unlocks')
        .values({
          id: write.featureUnlockId,
          payer_user_id: write.userId,
          feature_type: featureType,
          like_id: write.target.type === 'like' ? write.target.targetId : null,
          match_id: write.target.type === 'match' ? write.target.targetId : null,
          payment_record_id: null,
          credit_transaction_id: write.creditTransactionId,
          expires_at: null,
          revoked_at: null,
          revoked_reason: null,
          revoked_by_admin_id: null,
          expired_at: null,
        })
        .returning(['id', 'feature_type', 'unlocked_at'])
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('billing.credit_transactions')
        .values({
          id: write.creditTransactionId,
          credit_account_id: write.userId,
          user_id: write.userId,
          account_version: accountVersion,
          transaction_type:
            write.target.type === 'like' ? 'spend_liked_by_unlock' : 'spend_chat_unlock',
          amount: (-price).toString(),
          balance_before: balanceBefore.toString(),
          balance_after: balanceAfter.toString(),
          payment_record_id: null,
          pending_payment_id: null,
          feature_unlock_id: write.featureUnlockId,
          nakh_id: null,
          idempotency_key: idempotencyKey,
          correlation_id: write.correlationId,
        })
        .execute();
      await transaction
        .updateTable('billing.credit_accounts')
        .set({
          balance: balanceAfter.toString(),
          version: accountVersion,
          updated_at: unlock.unlocked_at,
        })
        .where('user_id', '=', write.userId)
        .where('version', '=', account.version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.outboxEventId,
          aggregate_type: 'feature_unlock',
          aggregate_id: unlock.id,
          event_type: 'entitlement.feature-unlocked.v1',
          schema_version: 1,
          payload: { featureUnlockId: unlock.id, featureType },
          occurred_at: unlock.unlocked_at,
          available_at: unlock.unlocked_at,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.correlationId,
          causation_id: write.correlationId,
        })
        .execute();
      return result(unlock, false);
    });
  }
}
