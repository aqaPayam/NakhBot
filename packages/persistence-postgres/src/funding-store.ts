import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  BillingFundingStore,
  CreateFundingIntentWrite,
  PrepareStarsAttemptWrite,
  ResolvedFundingTarget,
  StoredFundingIntent,
  StoredStarsAttempt,
} from '@nakh/application';
import {
  ApplicationError,
  FUNDING_INTENT_TTL_MS,
  PROVIDER_ATTEMPT_LIMIT,
  PROVIDER_ATTEMPT_WINDOW_MS,
  getPaidActionPrice,
} from '@nakh/domain';

import { actionableLikedByFrom } from './liked-by-store.js';
import type { NakhDatabase } from './database.js';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fundingName(funding: 'credits' | 'stars'): 'credits' | 'telegram_stars' {
  return funding === 'credits' ? 'credits' : 'telegram_stars';
}

type IntentFacts = Readonly<{
  reason: 'unlock_chat' | 'unlock_liked_by_profile' | 'buy_credit_package';
  targetType: 'credit_package' | 'like' | 'match';
  targetId: string;
  requiredAmount: bigint;
  packageCode?: string;
  packageCredits?: bigint;
}>;

export class PostgresFundingStore implements BillingFundingStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async createFundingIntent(write: CreateFundingIntentWrite): Promise<StoredFundingIntent> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'billing-user:'} || ${write.userId}::text, 0))`.execute(
        transaction,
      );
      const facts = await this.resolveIntentFacts(
        transaction,
        write.userId,
        write.target,
        write.funding,
      );
      const requestHash = hash({
        userId: write.userId,
        funding: write.funding,
        reason: facts.reason,
        targetType: facts.targetType,
        targetId: facts.targetId,
        requiredAmount: facts.requiredAmount.toString(),
        packageCode: facts.packageCode,
        packageCredits: facts.packageCredits?.toString(),
      });
      const existing = await transaction
        .selectFrom('billing.pending_payments')
        .selectAll()
        .where('user_id', '=', write.userId)
        .where('idempotency_key', '=', write.idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.billing.idempotency_conflict',
            409,
          );
        return this.intentResult(existing, true);
      }

      const open = await transaction
        .selectFrom('billing.pending_payments')
        .selectAll()
        .where('user_id', '=', write.userId)
        .where('reason', '=', facts.reason)
        .where('target_type', '=', facts.targetType)
        .where('target_id', '=', facts.targetId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (open !== undefined) {
        if (open.request_hash === requestHash) return this.intentResult(open, true);
        throw new ApplicationError('payment_pending', 'error.billing.payment_pending', 409);
      }

      const time = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
        transaction,
      );
      const now = time.rows[0]!.now;
      const expiresAt = new Date(now.getTime() + FUNDING_INTENT_TTL_MS);
      const inserted = await transaction
        .insertInto('billing.pending_payments')
        .values({
          id: write.intentId,
          user_id: write.userId,
          reason: facts.reason,
          target_type: facts.targetType,
          target_id: facts.targetId,
          funding_type: fundingName(write.funding),
          required_credits: write.funding === 'credits' ? facts.requiredAmount.toString() : null,
          required_stars: write.funding === 'stars' ? facts.requiredAmount.toString() : null,
          package_code_snapshot: facts.packageCode ?? null,
          package_credit_amount_snapshot: facts.packageCredits?.toString() ?? null,
          idempotency_key: write.idempotencyKey,
          request_hash: requestHash,
          expires_at: expiresAt,
          resolved_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.intentResult(inserted, false);
    });
  }

  public async prepareStarsAttempt(write: PrepareStarsAttemptWrite): Promise<StoredStarsAttempt> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'billing-user:'} || ${write.userId}::text, 0))`.execute(
        transaction,
      );
      const requestHash = hash({
        userId: write.userId,
        fundingIntentId: write.fundingIntentId,
        expectedVersion: write.expectedVersion,
        providerEnvironment: write.providerEnvironment,
        providerBotIdDigest: write.providerBotIdDigest,
      });
      const existing = await transaction
        .selectFrom('billing.payment_records')
        .selectAll()
        .where('user_id', '=', write.userId)
        .where('idempotency_key', '=', write.idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.billing.idempotency_conflict',
            409,
          );
        const intent = await transaction
          .selectFrom('billing.pending_payments')
          .select('expires_at')
          .where('id', '=', existing.pending_payment_id)
          .executeTakeFirstOrThrow();
        return this.attemptResult(existing, intent.expires_at, true);
      }

      const intent = await transaction
        .selectFrom('billing.pending_payments')
        .selectAll()
        .where('id', '=', write.fundingIntentId)
        .where('user_id', '=', write.userId)
        .forUpdate()
        .executeTakeFirst();
      if (intent === undefined)
        throw new ApplicationError('not_found', 'error.billing.payment_not_found', 404);
      const time = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
        transaction,
      );
      const now = time.rows[0]!.now;
      if (intent.status !== 'pending')
        throw new ApplicationError('payment_pending', 'error.billing.payment_unavailable', 409);
      if (intent.version !== write.expectedVersion)
        throw new ApplicationError(
          'version_conflict',
          'error.billing.payment_version_conflict',
          409,
        );
      if (intent.expires_at <= now)
        throw new ApplicationError('payment_expired', 'error.billing.payment_expired', 409);
      if (intent.funding_type !== 'telegram_stars' || intent.required_stars === null)
        throw new ApplicationError('invalid_request', 'error.billing.stars_not_selected', 400);

      const cutoff = new Date(now.getTime() - PROVIDER_ATTEMPT_WINDOW_MS);
      const count = await transaction
        .selectFrom('billing.payment_records')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('user_id', '=', write.userId)
        .where('created_at', '>', cutoff)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= PROVIDER_ATTEMPT_LIMIT)
        throw new ApplicationError('payment_attempt_limit', 'error.billing.attempt_limit', 429);

      const packagePayment = intent.reason === 'buy_credit_package';
      const paidActionReason = intent.reason === 'buy_credit_package' ? null : intent.reason;
      const inserted = await transaction
        .insertInto('billing.payment_records')
        .values({
          id: write.paymentRecordId,
          user_id: write.userId,
          pending_payment_id: intent.id,
          payment_type: packagePayment ? 'buy_credit_package' : 'direct_paid_action',
          paid_action_reason: paidActionReason,
          credit_package_id: packagePayment ? intent.target_id : null,
          package_code_snapshot: intent.package_code_snapshot,
          package_credit_amount_snapshot: intent.package_credit_amount_snapshot,
          stars_amount: intent.required_stars,
          provider: 'telegram_stars',
          provider_environment: write.providerEnvironment,
          provider_bot_id_digest: write.providerBotIdDigest,
          invoice_payload_digest: write.payload.digest,
          invoice_payload_ciphertext: write.payload.ciphertext,
          invoice_payload_key_id: write.payload.keyId,
          provider_payment_id: null,
          idempotency_key: write.idempotencyKey,
          request_hash: requestHash,
          paid_at: null,
          failed_at: null,
          cancelled_at: null,
          expired_at: null,
          refunded_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.attemptResult(inserted, intent.expires_at, false);
    });
  }

  private intentResult(
    row: Readonly<{
      id: string;
      funding_type: 'credits' | 'telegram_stars';
      required_credits: string | null;
      required_stars: string | null;
      expires_at: Date;
    }>,
    replayed: boolean,
  ): StoredFundingIntent {
    const amount = row.funding_type === 'credits' ? row.required_credits : row.required_stars;
    if (amount === null) throw new ApplicationError('internal_error', 'error.internal', 500);
    return {
      id: row.id,
      funding: row.funding_type === 'credits' ? 'credits' : 'stars',
      requiredAmount: BigInt(amount),
      expiresAt: row.expires_at,
      replayed,
    };
  }

  private attemptResult(
    row: Readonly<{
      id: string;
      stars_amount: string;
      invoice_payload_ciphertext: Uint8Array;
      invoice_payload_key_id: string;
    }>,
    expiresAt: Date,
    replayed: boolean,
  ): StoredStarsAttempt {
    return {
      paymentRecordId: row.id,
      starsAmount: BigInt(row.stars_amount),
      expiresAt,
      payloadCiphertext: row.invoice_payload_ciphertext,
      payloadKeyId: row.invoice_payload_key_id,
      replayed,
    };
  }

  private async resolveIntentFacts(
    database: NakhDatabase,
    userId: string,
    target: ResolvedFundingTarget,
    funding: 'credits' | 'stars',
  ): Promise<IntentFacts> {
    if (target.type === 'credit_package') {
      if (funding !== 'stars')
        throw new ApplicationError('invalid_request', 'error.billing.package_requires_stars', 400);
      const account = await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (account?.state !== 'active')
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      const row = await database
        .selectFrom('billing.credit_packages')
        .select(['id', 'code', 'credit_amount', 'stars_price'])
        .where('code', '=', target.packageCode)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (row === undefined)
        throw new ApplicationError('package_unavailable', 'error.billing.package_unavailable', 409);
      return {
        reason: 'buy_credit_package',
        targetType: 'credit_package',
        targetId: row.id,
        requiredAmount: BigInt(row.stars_price),
        packageCode: row.code,
        packageCredits: BigInt(row.credit_amount),
      };
    }

    if (target.type === 'like') {
      const receiver = await database
        .selectFrom('identity.accounts as account')
        .innerJoin('identity.user_settings as settings', 'settings.user_id', 'account.user_id')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'account.user_id')
        .select(['account.state', 'settings.visibility_enabled', 'profile.completion_status'])
        .where('account.user_id', '=', userId)
        .executeTakeFirst();
      if (
        receiver?.state !== 'active' ||
        !receiver.visibility_enabled ||
        receiver.completion_status !== 'complete'
      )
        throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
      const actionable = await sql<{ id: string }>`
        SELECT incoming.id ${actionableLikedByFrom(userId)}
        AND incoming.id = ${target.targetId}::uuid
      `.execute(database);
      if (actionable.rows.length !== 1)
        throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
      return {
        reason: 'unlock_liked_by_profile',
        targetType: 'like',
        targetId: target.targetId,
        requiredAmount: getPaidActionPrice('unlock_liked_by_profile', funding),
      };
    }

    const match = await database
      .selectFrom('matching.matches as match')
      .innerJoin('matching.match_participants as participant', 'participant.match_id', 'match.id')
      .innerJoin('chat.chat_sessions as chat', 'chat.match_id', 'match.id')
      .innerJoin(
        'identity.accounts as payer_account',
        'payer_account.user_id',
        'participant.user_id',
      )
      .innerJoin('interaction.user_pair_states as pair', (join) =>
        join
          .onRef('pair.user_low_id', '=', 'match.user_low_id')
          .onRef('pair.user_high_id', '=', 'match.user_high_id'),
      )
      .select('match.id')
      .where('match.id', '=', target.targetId)
      .where('participant.user_id', '=', userId)
      .where('payer_account.state', '=', 'active')
      .where('match.status', '=', 'active')
      .where('chat.status', '=', 'active')
      .where('pair.state', '=', 'matched')
      .executeTakeFirst();
    if (match === undefined)
      throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
    return {
      reason: 'unlock_chat',
      targetType: 'match',
      targetId: target.targetId,
      requiredAmount: getPaidActionPrice('unlock_chat', funding),
    };
  }
}
