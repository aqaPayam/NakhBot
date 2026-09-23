import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  EncryptedProviderEvidence,
  InvoicePayloadProtector,
  PaidActionTarget,
  TelegramPaymentReceiptResult,
  TelegramPreCheckoutDecision,
  TelegramPreCheckoutWrite,
  TelegramStarsReceiptStore,
  TelegramSuccessfulPaymentWrite,
} from '@nakh/application';
import {
  ApplicationError,
  calculateCreditBalance,
  DELIVERED_NAKH_LIFETIME_MS,
  NAKH_STARS_COST,
  type IdGenerator,
} from '@nakh/domain';

import { actionableLikedByFrom } from './liked-by-store.js';
import {
  insertFeatureUnlockNotifications,
  insertNotification,
  insertPaymentSuccessNotification,
} from './notification-store.js';
import { lockUserPair } from './pair-lock.js';
import { lockAndValidatePaidActionTarget } from './paid-action-store.js';
import type { NakhDatabase } from './database.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^(?:[1-9][0-9]{0,19})$/u;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/u;
const OWNER = /^[\x20-\x7e]{1,128}$/u;
const EXTERNAL_ID = /^[\x21-\x7e]{1,256}$/u;

type StoredPayment = Readonly<{
  id: string;
  user_id: string;
  pending_payment_id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'refunded';
  stars_amount: string;
  provider_environment: 'local' | 'test' | 'staging' | 'production';
  provider_bot_id_digest: string;
  provider_payment_id: string | null;
  version: number;
  intent_status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired';
  reason: 'send_nakh' | 'unlock_chat' | 'unlock_liked_by_profile' | 'buy_credit_package';
  target_type: 'credit_package' | 'like' | 'match' | 'pending_nakh';
  target_id: string;
  expires_at: Date;
  intent_version: number;
}>;

export type PaymentFulfillmentClaim = Readonly<{
  owner: string;
  leaseMs: number;
  limit: number;
}>;

export type ClaimedPaymentFulfillment = Readonly<{
  paymentRecordId: string;
  attemptCount: number;
  fenceToken: bigint;
}>;

export type PaymentFulfillmentLease = Readonly<{
  paymentRecordId: string;
  owner: string;
  fenceToken: bigint;
}>;

export type CreditPackageFulfillmentWrite = PaymentFulfillmentLease &
  Readonly<{
    creditTransactionId: string;
    creditIncreasedEventId: string;
    paymentFulfilledEventId: string;
  }>;

export type CreditPackageFulfillmentResult = Readonly<{
  paymentRecordId: string;
  creditTransactionId: string;
  balanceAfter: bigint;
  replayed: boolean;
}>;

export type DirectPaidActionFulfillmentWrite = PaymentFulfillmentLease &
  Readonly<{
    featureUnlockId: string;
    refundRecordId: string;
    featureUnlockedEventId: string;
    paymentTerminalEventId: string;
  }>;

export type DirectPaidActionFulfillmentResult = Readonly<{
  paymentRecordId: string;
  outcome: 'fulfilled' | 'correction_required';
  featureUnlockId?: string;
  refundRecordId?: string;
  replayed: boolean;
}>;

export type PendingNakhStarsFulfillmentWrite = PaymentFulfillmentLease &
  Readonly<{
    nakhId: string;
    historyId: string;
    refundRecordId: string;
    deliveredEventId: string;
    paymentTerminalEventId: string;
  }>;

export type PendingNakhStarsFulfillmentResult = Readonly<{
  paymentRecordId: string;
  outcome: 'fulfilled' | 'correction_required';
  nakhId?: string;
  refundRecordId?: string;
  replayed: boolean;
}>;

function factHash(value: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateEvidence(evidence: EncryptedProviderEvidence): void {
  if (
    !SHA256.test(evidence.digest) ||
    !(evidence.ciphertext instanceof Uint8Array) ||
    evidence.ciphertext.byteLength < 32 ||
    evidence.ciphertext.byteLength > 65_536 ||
    !KEY_ID.test(evidence.keyId) ||
    !Number.isSafeInteger(evidence.schemaVersion) ||
    evidence.schemaVersion < 1
  )
    throw new ApplicationError('invalid_request', 'error.billing.provider_callback_invalid', 400);
}

function validateCommon(write: TelegramPreCheckoutWrite): void {
  validateEvidence(write.evidence);
  if (
    !EXTERNAL_ID.test(write.providerEventId) ||
    !PROVIDER_ID.test(write.telegramUserId) ||
    typeof write.invoicePayload !== 'string' ||
    write.invoicePayload.length < 1 ||
    write.invoicePayload.length > 256 ||
    typeof write.currency !== 'string' ||
    write.currency.length < 1 ||
    write.currency.length > 8 ||
    typeof write.totalAmount !== 'bigint' ||
    write.totalAmount <= 0n ||
    !['local', 'test', 'staging', 'production'].includes(write.providerEnvironment) ||
    !SHA256.test(write.providerBotIdDigest)
  )
    throw new ApplicationError('invalid_request', 'error.billing.provider_callback_invalid', 400);
}

function commonFacts(write: TelegramPreCheckoutWrite, eventType: string): Record<string, string> {
  return {
    eventType,
    telegramUserId: write.telegramUserId,
    invoicePayload: write.invoicePayload,
    currency: write.currency,
    totalAmount: write.totalAmount.toString(),
    providerEnvironment: write.providerEnvironment,
    providerBotIdDigest: write.providerBotIdDigest,
  };
}

function reasonForPayment(
  payment: StoredPayment | undefined,
  payerUserId: string | undefined,
  write: TelegramPreCheckoutWrite,
  now: Date,
): TelegramPreCheckoutDecision['reasonCode'] | undefined {
  if (payment === undefined || payment.status !== 'pending' || payment.intent_status !== 'pending')
    return 'payment_unavailable';
  if (payment.expires_at <= now) return 'payment_expired';
  if (payerUserId !== payment.user_id) return 'payer_mismatch';
  if (
    payment.provider_environment !== write.providerEnvironment ||
    payment.provider_bot_id_digest !== write.providerBotIdDigest
  )
    return 'provider_mismatch';
  if (write.currency !== 'XTR') return 'currency_mismatch';
  if (BigInt(payment.stars_amount) !== write.totalAmount) return 'amount_mismatch';
  return undefined;
}

export class PostgresTelegramStarsReceiptStore implements TelegramStarsReceiptStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly ids: IdGenerator,
    private readonly payloads: Pick<InvoicePayloadProtector, 'digest'>,
  ) {}

  public async validatePreCheckout(
    write: TelegramPreCheckoutWrite,
  ): Promise<TelegramPreCheckoutDecision> {
    validateCommon(write);
    const incomingFactHash = factHash(commonFacts(write, 'pre_checkout'));
    return this.database.transaction().execute(async (transaction) => {
      await this.lockProviderEvent(transaction, write.providerEventId);
      const replay = await transaction
        .selectFrom('billing.payment_provider_events')
        .select(['id', 'fact_hash', 'decision', 'reason_code'])
        .where('provider', '=', 'telegram_stars')
        .where('provider_event_id', '=', write.providerEventId)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.fact_hash !== incomingFactHash) {
          await this.recordConflict(
            transaction,
            write,
            incomingFactHash,
            replay.fact_hash,
            null,
            'event_fact_conflict',
          );
          return { allowed: false, reasonCode: 'callback_conflict', replayed: true };
        }
        if (replay.reason_code === null)
          return { allowed: replay.decision === 'allow', replayed: true };
        return {
          allowed: replay.decision === 'allow',
          reasonCode: replay.reason_code as NonNullable<TelegramPreCheckoutDecision['reasonCode']>,
          replayed: true,
        };
      }

      const payment = await this.findPayment(transaction, write.invoicePayload, false);
      const payerUserId = await this.findPayer(transaction, write.telegramUserId);
      const clock = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
        transaction,
      );
      let reason = reasonForPayment(payment, payerUserId, write, clock.rows[0]!.now);
      if (reason === undefined && payment !== undefined) {
        const available = await this.targetAvailable(transaction, payment);
        if (!available) reason = 'target_unavailable';
      }
      const allowed = reason === undefined;
      await this.insertProviderEvent(transaction, {
        write,
        incomingFactHash,
        eventType: 'pre_checkout',
        ...(payment === undefined ? {} : { paymentRecordId: payment.id }),
        ...(payerUserId === undefined ? {} : { payerUserId }),
        decision: allowed ? 'allow' : 'deny',
        ...(reason === undefined ? {} : { reasonCode: reason }),
      });
      return { allowed, ...(reason === undefined ? {} : { reasonCode: reason }), replayed: false };
    });
  }

  public async recordSuccessfulPayment(
    write: TelegramSuccessfulPaymentWrite,
  ): Promise<TelegramPaymentReceiptResult> {
    validateCommon(write);
    if (
      !EXTERNAL_ID.test(write.telegramChargeId) ||
      (write.providerChargeId !== undefined && !EXTERNAL_ID.test(write.providerChargeId))
    )
      throw new ApplicationError('invalid_request', 'error.billing.provider_callback_invalid', 400);
    const incomingFactHash = factHash({
      ...commonFacts(write, 'successful_payment'),
      telegramChargeId: write.telegramChargeId,
      providerChargeId: write.providerChargeId ?? '',
    });
    return this.database.transaction().execute(async (transaction) => {
      await this.lockProviderEvent(transaction, write.providerEventId);
      const existingEvent = await transaction
        .selectFrom('billing.payment_provider_events')
        .select(['fact_hash', 'decision', 'payment_record_id', 'reason_code'])
        .where('provider', '=', 'telegram_stars')
        .where('provider_event_id', '=', write.providerEventId)
        .executeTakeFirst();
      if (existingEvent !== undefined) {
        if (existingEvent.fact_hash !== incomingFactHash) {
          await this.recordConflict(
            transaction,
            write,
            incomingFactHash,
            existingEvent.fact_hash,
            existingEvent.payment_record_id,
            'event_fact_conflict',
          );
          return { outcome: 'quarantined', reasonCode: 'callback_conflict' };
        }
        return existingEvent.decision === 'receipt_recorded'
          ? {
              outcome: 'replayed',
              ...(existingEvent.payment_record_id === null
                ? {}
                : { paymentRecordId: existingEvent.payment_record_id }),
            }
          : {
              outcome: 'quarantined',
              reasonCode:
                existingEvent.reason_code === 'charge_conflict'
                  ? 'charge_conflict'
                  : 'payment_fact_mismatch',
            };
      }

      const payment = await this.findPayment(transaction, write.invoicePayload, true);
      const payerUserId = await this.findPayer(transaction, write.telegramUserId);
      const factsMatch =
        payment !== undefined &&
        payerUserId === payment.user_id &&
        payment.provider_environment === write.providerEnvironment &&
        payment.provider_bot_id_digest === write.providerBotIdDigest &&
        write.currency === 'XTR' &&
        BigInt(payment.stars_amount) === write.totalAmount;
      if (!factsMatch) {
        await this.insertProviderEvent(transaction, {
          write,
          incomingFactHash,
          eventType: 'successful_payment',
          ...(payment === undefined ? {} : { paymentRecordId: payment.id }),
          ...(payerUserId === undefined ? {} : { payerUserId }),
          decision: 'quarantined',
          reasonCode: 'payment_fact_mismatch',
        });
        await this.recordConflict(
          transaction,
          write,
          incomingFactHash,
          null,
          payment?.id ?? null,
          'payment_fact_mismatch',
        );
        return { outcome: 'quarantined', reasonCode: 'payment_fact_mismatch' };
      }

      const chargeOwner = await transaction
        .selectFrom('billing.telegram_stars_receipts')
        .selectAll()
        .where((expression) =>
          expression.or([
            expression('payment_record_id', '=', payment.id),
            expression('telegram_charge_id', '=', write.telegramChargeId),
            ...(write.providerChargeId === undefined
              ? []
              : [expression('provider_charge_id', '=', write.providerChargeId)]),
          ]),
        )
        .executeTakeFirst();
      if (chargeOwner !== undefined) {
        const exact =
          chargeOwner.payment_record_id === payment.id &&
          chargeOwner.telegram_charge_id === write.telegramChargeId &&
          chargeOwner.provider_charge_id === (write.providerChargeId ?? null) &&
          chargeOwner.payer_user_id === payment.user_id &&
          BigInt(chargeOwner.stars_amount) === write.totalAmount;
        if (!exact) {
          await this.insertProviderEvent(transaction, {
            write,
            incomingFactHash,
            eventType: 'successful_payment',
            paymentRecordId: payment.id,
            payerUserId,
            decision: 'quarantined',
            reasonCode: 'charge_conflict',
          });
          await this.recordConflict(
            transaction,
            write,
            incomingFactHash,
            null,
            payment.id,
            'charge_conflict',
          );
          return { outcome: 'quarantined', reasonCode: 'charge_conflict' };
        }
      }

      await this.insertProviderEvent(transaction, {
        write,
        incomingFactHash,
        eventType: 'successful_payment',
        paymentRecordId: payment.id,
        payerUserId,
        decision: 'receipt_recorded',
      });
      if (chargeOwner !== undefined) return { outcome: 'replayed', paymentRecordId: payment.id };

      await transaction
        .insertInto('billing.telegram_stars_receipts')
        .values({
          payment_record_id: payment.id,
          provider_event_id: write.providerEventId,
          telegram_charge_id: write.telegramChargeId,
          provider_charge_id: write.providerChargeId ?? null,
          payer_user_id: payment.user_id,
          stars_amount: write.totalAmount.toString(),
        })
        .execute();

      if (payment.status === 'pending') {
        await transaction
          .updateTable('billing.payment_records')
          .set((expression) => ({
            status: 'paid',
            provider_payment_id: write.telegramChargeId,
            paid_at: sql<Date>`transaction_timestamp()`,
            version: expression('version', '+', 1),
          }))
          .where('id', '=', payment.id)
          .where('status', '=', 'pending')
          .where('version', '=', payment.version)
          .executeTakeFirstOrThrow();
        if (payment.intent_status === 'pending')
          await transaction
            .updateTable('billing.pending_payments')
            .set((expression) => ({
              status: 'paid',
              resolved_at: sql<Date>`transaction_timestamp()`,
              version: expression('version', '+', 1),
            }))
            .where('id', '=', payment.pending_payment_id)
            .where('status', '=', 'pending')
            .where('version', '=', payment.intent_version)
            .executeTakeFirstOrThrow();
      }

      const correctionRequired =
        payment.status !== 'pending' || payment.intent_status !== 'pending';
      if (correctionRequired)
        await transaction
          .insertInto('billing.refund_records')
          .values({
            id: this.ids.uuid(),
            user_id: payment.user_id,
            funding_type: 'telegram_stars',
            payment_record_id: payment.id,
            original_credit_transaction_id: null,
            refund_credit_transaction_id: null,
            telegram_charge_id: write.telegramChargeId,
            reason_code: 'target_unavailable',
            stars_amount: payment.stars_amount,
            credits_amount: null,
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: null,
            idempotency_key: `stars-refund:${payment.id}`,
            processed_at: null,
            failed_at: null,
          })
          .execute();
      await transaction
        .insertInto('billing.payment_fulfillments')
        .values({
          payment_record_id: payment.id,
          state: correctionRequired ? 'correction_required' : 'receipt_recorded',
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: correctionRequired ? 'payment_state_conflict' : null,
          fulfilled_at: null,
          correction_required_at: correctionRequired ? sql<Date>`transaction_timestamp()` : null,
          corrected_at: null,
        })
        .execute();
      const outboxId = this.ids.uuid();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: outboxId,
          aggregate_type: 'payment_record',
          aggregate_id: payment.id,
          event_type: correctionRequired
            ? 'billing.payment-correction-required.v1'
            : 'billing.payment-receipt-recorded.v1',
          schema_version: 1,
          payload: { paymentRecordId: payment.id },
          occurred_at: sql<Date>`transaction_timestamp()`,
          available_at: sql<Date>`transaction_timestamp()`,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: outboxId,
          causation_id: outboxId,
        })
        .execute();
      return { outcome: 'receipt_recorded', paymentRecordId: payment.id };
    });
  }

  /** Completes a captured package purchase and its ledger credit in one fenced transaction. */
  public async fulfillCreditPackage(
    input: CreditPackageFulfillmentWrite,
  ): Promise<CreditPackageFulfillmentResult> {
    this.validateLease(input);
    return this.database.transaction().execute(async (transaction) => {
      const fulfillment = await transaction
        .selectFrom('billing.payment_fulfillments')
        .selectAll()
        .select(sql<Date>`transaction_timestamp()`.as('database_now'))
        .where('payment_record_id', '=', input.paymentRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (fulfillment === undefined)
        throw new ApplicationError('not_found', 'error.billing.fulfillment_not_found', 404);
      if (fulfillment.state === 'fulfilled') {
        const prior = await transaction
          .selectFrom('billing.credit_transactions')
          .select(['id', 'balance_after'])
          .where('payment_record_id', '=', input.paymentRecordId)
          .where('transaction_type', '=', 'purchase')
          .executeTakeFirstOrThrow();
        return {
          paymentRecordId: input.paymentRecordId,
          creditTransactionId: prior.id,
          balanceAfter: BigInt(prior.balance_after),
          replayed: true,
        };
      }
      if (
        fulfillment.state !== 'fulfillment_pending' ||
        fulfillment.lease_owner !== input.owner ||
        BigInt(fulfillment.fence_token) !== input.fenceToken ||
        fulfillment.lease_expires_at === null ||
        fulfillment.lease_expires_at <= fulfillment.database_now
      )
        throw new ApplicationError('conflict', 'error.billing.fulfillment_lease_lost', 409);

      const payment = await transaction
        .selectFrom('billing.payment_records as payment')
        .innerJoin('billing.pending_payments as intent', 'intent.id', 'payment.pending_payment_id')
        .innerJoin(
          'billing.telegram_stars_receipts as receipt',
          'receipt.payment_record_id',
          'payment.id',
        )
        .select([
          'payment.id',
          'payment.user_id',
          'payment.payment_type',
          'payment.status',
          'payment.stars_amount',
          'payment.package_credit_amount_snapshot',
          'payment.credit_package_id',
          'intent.status as intent_status',
          'intent.target_id',
          'receipt.stars_amount as receipt_stars_amount',
        ])
        .where('payment.id', '=', input.paymentRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (
        payment === undefined ||
        payment.payment_type !== 'buy_credit_package' ||
        payment.status !== 'paid' ||
        payment.intent_status !== 'paid' ||
        payment.credit_package_id === null ||
        payment.credit_package_id !== payment.target_id ||
        payment.package_credit_amount_snapshot === null ||
        payment.stars_amount !== payment.receipt_stars_amount
      )
        throw new ApplicationError(
          'payment_verification_failed',
          'error.billing.payment_mismatch',
          409,
        );

      const account = await transaction
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', payment.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const balanceBefore = BigInt(account.balance);
      const amount = BigInt(payment.package_credit_amount_snapshot);
      const balanceAfter = calculateCreditBalance({
        transactionType: 'purchase',
        balanceBefore,
        amount,
      });
      const accountVersion = account.version + 1;
      const recordedAt = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(
        transaction,
      );
      const now = recordedAt.rows[0]!.now;
      await transaction
        .insertInto('billing.credit_transactions')
        .values({
          id: input.creditTransactionId,
          credit_account_id: payment.user_id,
          user_id: payment.user_id,
          account_version: accountVersion,
          transaction_type: 'purchase',
          amount: amount.toString(),
          balance_before: balanceBefore.toString(),
          balance_after: balanceAfter.toString(),
          payment_record_id: payment.id,
          pending_payment_id: null,
          feature_unlock_id: null,
          nakh_id: null,
          idempotency_key: `purchase:${payment.id}`,
          correlation_id: payment.id,
        })
        .execute();
      await transaction
        .updateTable('billing.credit_accounts')
        .set({ balance: balanceAfter.toString(), version: accountVersion, updated_at: now })
        .where('user_id', '=', payment.user_id)
        .where('version', '=', account.version)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.payment_fulfillments')
        .set((expression) => ({
          state: 'fulfilled',
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: null,
          fulfilled_at: now,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('payment_record_id', '=', payment.id)
        .where('state', '=', 'fulfillment_pending')
        .where('lease_owner', '=', input.owner)
        .where('fence_token', '=', input.fenceToken.toString())
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values([
          {
            id: input.creditIncreasedEventId,
            aggregate_type: 'credit_account',
            aggregate_id: payment.user_id,
            event_type: 'billing.credit-increased.v1',
            schema_version: 1,
            payload: {
              creditTransactionId: input.creditTransactionId,
              amount: amount.toString(),
              balanceAfter: balanceAfter.toString(),
            },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: payment.id,
            causation_id: payment.id,
          },
          {
            id: input.paymentFulfilledEventId,
            aggregate_type: 'payment_record',
            aggregate_id: payment.id,
            event_type: 'billing.payment-fulfilled.v1',
            schema_version: 1,
            payload: { paymentRecordId: payment.id },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: payment.id,
            causation_id: payment.id,
          },
        ])
        .execute();
      await insertPaymentSuccessNotification(transaction, {
        paymentRecordId: payment.id,
        userId: payment.user_id,
        payload: {
          creditTransactionId: input.creditTransactionId,
          creditsAdded: amount.toString(),
          balanceAfter: balanceAfter.toString(),
        },
      });
      return {
        paymentRecordId: payment.id,
        creditTransactionId: input.creditTransactionId,
        balanceAfter,
        replayed: false,
      };
    });
  }

  /** Grants one payment-funded Like/Match entitlement or durably requests correction. */
  public async fulfillDirectPaidAction(
    input: DirectPaidActionFulfillmentWrite,
  ): Promise<DirectPaidActionFulfillmentResult> {
    this.validateLease(input);
    return this.database.transaction().execute(async (transaction) => {
      const fulfillment = await transaction
        .selectFrom('billing.payment_fulfillments')
        .selectAll()
        .select(sql<Date>`transaction_timestamp()`.as('database_now'))
        .where('payment_record_id', '=', input.paymentRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (fulfillment === undefined)
        throw new ApplicationError('not_found', 'error.billing.fulfillment_not_found', 404);
      if (fulfillment.state === 'fulfilled') {
        const prior = await transaction
          .selectFrom('interaction.feature_unlocks')
          .select('id')
          .where('payment_record_id', '=', input.paymentRecordId)
          .executeTakeFirstOrThrow();
        return {
          paymentRecordId: input.paymentRecordId,
          outcome: 'fulfilled',
          featureUnlockId: prior.id,
          replayed: true,
        };
      }
      if (fulfillment.state === 'correction_required') {
        const prior = await transaction
          .selectFrom('billing.refund_records')
          .select('id')
          .where('payment_record_id', '=', input.paymentRecordId)
          .executeTakeFirstOrThrow();
        return {
          paymentRecordId: input.paymentRecordId,
          outcome: 'correction_required',
          refundRecordId: prior.id,
          replayed: true,
        };
      }
      if (
        fulfillment.state !== 'fulfillment_pending' ||
        fulfillment.lease_owner !== input.owner ||
        BigInt(fulfillment.fence_token) !== input.fenceToken ||
        fulfillment.lease_expires_at === null ||
        fulfillment.lease_expires_at <= fulfillment.database_now
      )
        throw new ApplicationError('conflict', 'error.billing.fulfillment_lease_lost', 409);

      const payment = await transaction
        .selectFrom('billing.payment_records as payment')
        .innerJoin('billing.pending_payments as intent', 'intent.id', 'payment.pending_payment_id')
        .innerJoin(
          'billing.telegram_stars_receipts as receipt',
          'receipt.payment_record_id',
          'payment.id',
        )
        .select([
          'payment.id',
          'payment.user_id',
          'payment.payment_type',
          'payment.paid_action_reason',
          'payment.status',
          'payment.stars_amount',
          'intent.status as intent_status',
          'intent.target_type',
          'intent.target_id',
          'receipt.stars_amount as receipt_stars_amount',
          'receipt.telegram_charge_id',
        ])
        .where('payment.id', '=', input.paymentRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (
        payment === undefined ||
        payment.payment_type !== 'direct_paid_action' ||
        payment.status !== 'paid' ||
        payment.intent_status !== 'paid' ||
        payment.stars_amount !== payment.receipt_stars_amount ||
        !(
          (payment.paid_action_reason === 'unlock_liked_by_profile' &&
            payment.target_type === 'like') ||
          (payment.paid_action_reason === 'unlock_chat' && payment.target_type === 'match')
        )
      )
        throw new ApplicationError(
          'payment_verification_failed',
          'error.billing.payment_mismatch',
          409,
        );
      const target: PaidActionTarget = {
        type: payment.target_type === 'like' ? 'like' : 'match',
        targetId: payment.target_id,
      };
      let targetAvailable = true;
      try {
        await lockAndValidatePaidActionTarget(transaction, payment.user_id, target);
      } catch (error) {
        if (!(error instanceof ApplicationError) || error.code !== 'unlock_unavailable')
          throw error;
        targetAvailable = false;
      }
      if (targetAvailable) {
        const existing = await transaction
          .selectFrom('interaction.feature_unlocks')
          .select(['id', 'payment_record_id'])
          .where(target.type === 'like' ? 'like_id' : 'match_id', '=', target.targetId)
          .executeTakeFirst();
        if (existing !== undefined && existing.payment_record_id !== payment.id)
          targetAvailable = false;
      }

      const now = fulfillment.database_now;
      if (!targetAvailable) {
        await transaction
          .insertInto('billing.refund_records')
          .values({
            id: input.refundRecordId,
            user_id: payment.user_id,
            funding_type: 'telegram_stars',
            payment_record_id: payment.id,
            original_credit_transaction_id: null,
            refund_credit_transaction_id: null,
            telegram_charge_id: payment.telegram_charge_id,
            reason_code: 'target_unavailable',
            stars_amount: payment.stars_amount,
            credits_amount: null,
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: null,
            idempotency_key: `stars-refund:${payment.id}`,
            processed_at: null,
            failed_at: null,
          })
          .execute();
        await transaction
          .updateTable('billing.payment_fulfillments')
          .set((expression) => ({
            state: 'correction_required',
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: 'target_unavailable',
            correction_required_at: now,
            updated_at: now,
            version: expression('version', '+', 1),
          }))
          .where('payment_record_id', '=', payment.id)
          .where('state', '=', 'fulfillment_pending')
          .where('lease_owner', '=', input.owner)
          .where('fence_token', '=', input.fenceToken.toString())
          .executeTakeFirstOrThrow();
        await this.insertTerminalPaymentEvent(
          transaction,
          input.paymentTerminalEventId,
          payment.id,
          'billing.payment-correction-required.v1',
          now,
        );
        return {
          paymentRecordId: payment.id,
          outcome: 'correction_required',
          refundRecordId: input.refundRecordId,
          replayed: false,
        };
      }

      const unlock = await transaction
        .insertInto('interaction.feature_unlocks')
        .values({
          id: input.featureUnlockId,
          payer_user_id: payment.user_id,
          feature_type: target.type === 'like' ? 'liked_by_profile_unlock' : 'chat_unlock',
          like_id: target.type === 'like' ? target.targetId : null,
          match_id: target.type === 'match' ? target.targetId : null,
          payment_record_id: payment.id,
          credit_transaction_id: null,
          expires_at: null,
          revoked_at: null,
          revoked_reason: null,
          revoked_by_admin_id: null,
          expired_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.payment_fulfillments')
        .set((expression) => ({
          state: 'fulfilled',
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: null,
          fulfilled_at: now,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('payment_record_id', '=', payment.id)
        .where('state', '=', 'fulfillment_pending')
        .where('lease_owner', '=', input.owner)
        .where('fence_token', '=', input.fenceToken.toString())
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: input.featureUnlockedEventId,
          aggregate_type: 'feature_unlock',
          aggregate_id: unlock.id,
          event_type: 'entitlement.feature-unlocked.v1',
          schema_version: 1,
          payload: {
            featureUnlockId: unlock.id,
            featureType: target.type === 'like' ? 'liked_by_profile_unlock' : 'chat_unlock',
          },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: payment.id,
          causation_id: payment.id,
        })
        .execute();
      await this.insertTerminalPaymentEvent(
        transaction,
        input.paymentTerminalEventId,
        payment.id,
        'billing.payment-fulfilled.v1',
        now,
      );
      await insertPaymentSuccessNotification(transaction, {
        paymentRecordId: payment.id,
        userId: payment.user_id,
        payload: { featureUnlockId: unlock.id },
      });
      await insertFeatureUnlockNotifications(transaction, {
        featureUnlockId: unlock.id,
        featureType: target.type === 'like' ? 'liked_by_profile_unlock' : 'chat_unlock',
        payerUserId: payment.user_id,
        ...(target.type === 'match' ? { matchId: target.targetId } : {}),
        correlationId: payment.id,
        causationId: payment.id,
      });
      return {
        paymentRecordId: payment.id,
        outcome: 'fulfilled',
        featureUnlockId: unlock.id,
        replayed: false,
      };
    });
  }

  /** Delivers one captured Pending Nakh or creates one fenced Stars correction. */
  public async fulfillPendingNakh(
    input: PendingNakhStarsFulfillmentWrite,
  ): Promise<PendingNakhStarsFulfillmentResult> {
    this.validateLease(input);
    return this.database.transaction().execute(async (transaction) => {
      const fulfillment = await transaction
        .selectFrom('billing.payment_fulfillments')
        .selectAll()
        .select(sql<Date>`transaction_timestamp()`.as('database_now'))
        .where('payment_record_id', '=', input.paymentRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (fulfillment === undefined)
        throw new ApplicationError('not_found', 'error.billing.fulfillment_not_found', 404);
      if (fulfillment.state === 'fulfilled') {
        const delivered = await transaction
          .selectFrom('nakh.nakhes')
          .select('id')
          .where('payment_record_id', '=', input.paymentRecordId)
          .executeTakeFirstOrThrow();
        return {
          paymentRecordId: input.paymentRecordId,
          outcome: 'fulfilled',
          nakhId: delivered.id,
          replayed: true,
        };
      }
      if (fulfillment.state === 'correction_required') {
        const correction = await transaction
          .selectFrom('billing.refund_records')
          .select('id')
          .where('payment_record_id', '=', input.paymentRecordId)
          .executeTakeFirstOrThrow();
        return {
          paymentRecordId: input.paymentRecordId,
          outcome: 'correction_required',
          refundRecordId: correction.id,
          replayed: true,
        };
      }
      if (
        fulfillment.state !== 'fulfillment_pending' ||
        fulfillment.lease_owner !== input.owner ||
        BigInt(fulfillment.fence_token) !== input.fenceToken ||
        fulfillment.lease_expires_at === null ||
        fulfillment.lease_expires_at <= fulfillment.database_now
      )
        throw new ApplicationError('conflict', 'error.billing.fulfillment_lease_lost', 409);

      const locator = await transaction
        .selectFrom('billing.payment_records as payment')
        .innerJoin('billing.pending_payments as intent', 'intent.id', 'payment.pending_payment_id')
        .innerJoin('nakh.pending_nakhes as pending', 'pending.id', 'intent.target_id')
        .innerJoin('nakh.nakh_flows as flow', 'flow.id', 'pending.nakh_flow_id')
        .select([
          'payment.user_id',
          'pending.id as pending_nakh_id',
          'flow.id as flow_id',
          'flow.receiver_user_id',
        ])
        .where('payment.id', '=', input.paymentRecordId)
        .executeTakeFirst();
      if (locator === undefined)
        throw new ApplicationError(
          'payment_verification_failed',
          'error.billing.payment_mismatch',
          409,
        );

      const counter = await transaction
        .selectFrom('platform.user_counters')
        .select(['user_id', 'pending_nakh_count'])
        .where('user_id', '=', locator.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pair = await lockUserPair(transaction, locator.user_id, locator.receiver_user_id);
      const users = await transaction
        .selectFrom('identity.users as user')
        .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'user.id')
        .select(['user.id', 'account.state', 'profile.completion_status'])
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
        .where('id', '=', locator.flow_id)
        .where('sender_user_id', '=', locator.user_id)
        .where('receiver_user_id', '=', locator.receiver_user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pending = await transaction
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('id', '=', locator.pending_nakh_id)
        .where('nakh_flow_id', '=', flow.id)
        .where('sender_user_id', '=', locator.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const payment = await transaction
        .selectFrom('billing.payment_records as payment')
        .innerJoin('billing.pending_payments as intent', 'intent.id', 'payment.pending_payment_id')
        .innerJoin(
          'billing.telegram_stars_receipts as receipt',
          'receipt.payment_record_id',
          'payment.id',
        )
        .select([
          'payment.id',
          'payment.user_id',
          'payment.payment_type',
          'payment.paid_action_reason',
          'payment.status',
          'payment.stars_amount',
          'intent.id as intent_id',
          'intent.status as intent_status',
          'intent.reason',
          'intent.target_type',
          'intent.target_id',
          'intent.required_stars',
          'receipt.stars_amount as receipt_stars_amount',
          'receipt.telegram_charge_id',
        ])
        .where('payment.id', '=', input.paymentRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (
        payment === undefined ||
        payment.user_id !== pending.sender_user_id ||
        payment.payment_type !== 'pay_pending_action' ||
        payment.paid_action_reason !== 'send_nakh' ||
        payment.status !== 'paid' ||
        payment.intent_status !== 'paid' ||
        payment.reason !== 'send_nakh' ||
        payment.target_type !== 'pending_nakh' ||
        payment.target_id !== pending.id ||
        payment.intent_id !== pending.pending_payment_id ||
        payment.required_stars === null ||
        BigInt(payment.required_stars) !== NAKH_STARS_COST ||
        payment.stars_amount !== payment.receipt_stars_amount
      )
        throw new ApplicationError(
          'payment_verification_failed',
          'error.billing.payment_mismatch',
          409,
        );

      const now = fulfillment.database_now;
      const eligible =
        pending.status === 'pending_payment' &&
        counter.pending_nakh_count > 0 &&
        users.length === 2 &&
        users.every((user) => user.state === 'active' && user.completion_status === 'complete') &&
        pairState === undefined;
      if (!eligible) {
        if (pending.status === 'pending_payment') {
          await transaction
            .updateTable('nakh.pending_nakhes')
            .set({
              status: 'closed_by_system',
              closed_at: now,
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
            .where('user_id', '=', pending.sender_user_id)
            .where('pending_nakh_count', '>', 0)
            .executeTakeFirstOrThrow();
        }
        await transaction
          .insertInto('billing.refund_records')
          .values({
            id: input.refundRecordId,
            user_id: payment.user_id,
            funding_type: 'telegram_stars',
            payment_record_id: payment.id,
            original_credit_transaction_id: null,
            refund_credit_transaction_id: null,
            telegram_charge_id: payment.telegram_charge_id,
            reason_code: 'target_unavailable',
            stars_amount: payment.stars_amount,
            credits_amount: null,
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: null,
            idempotency_key: `stars-refund:${payment.id}`,
            processed_at: null,
            failed_at: null,
          })
          .execute();
        await transaction
          .updateTable('billing.payment_fulfillments')
          .set((expression) => ({
            state: 'correction_required',
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: 'target_unavailable',
            correction_required_at: now,
            updated_at: now,
            version: expression('version', '+', 1),
          }))
          .where('payment_record_id', '=', payment.id)
          .where('state', '=', 'fulfillment_pending')
          .where('lease_owner', '=', input.owner)
          .where('fence_token', '=', input.fenceToken.toString())
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: input.deliveredEventId,
            aggregate_type: 'pending_nakh',
            aggregate_id: pending.id,
            event_type: 'nakh.status-changed.v1',
            schema_version: 1,
            payload: { pendingNakhId: pending.id, status: 'closed_by_system' },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: payment.id,
            causation_id: payment.id,
          })
          .execute();
        await this.insertTerminalPaymentEvent(
          transaction,
          input.paymentTerminalEventId,
          payment.id,
          'billing.payment-correction-required.v1',
          now,
        );
        return {
          paymentRecordId: payment.id,
          outcome: 'correction_required',
          refundRecordId: input.refundRecordId,
          replayed: false,
        };
      }

      const expiresAt = new Date(now.getTime() + DELIVERED_NAKH_LIFETIME_MS);
      await transaction
        .insertInto('nakh.nakhes')
        .values({
          id: input.nakhId,
          nakh_flow_id: flow.id,
          sender_user_id: flow.sender_user_id,
          receiver_user_id: flow.receiver_user_id,
          text: pending.text,
          funding_type: 'telegram_stars',
          credit_transaction_id: null,
          payment_record_id: payment.id,
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
          id: input.historyId,
          nakh_id: input.nakhId,
          nakh_version: 1,
          from_status: null,
          to_status: 'sent',
          reason_code: 'telegram_stars_funded',
          changed_by_user_id: payment.user_id,
          request_id: payment.id,
          changed_at: now,
        })
        .execute();
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
        .where('user_id', '=', pending.sender_user_id)
        .where('pending_nakh_count', '>', 0)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.payment_fulfillments')
        .set((expression) => ({
          state: 'fulfilled',
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: null,
          fulfilled_at: now,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('payment_record_id', '=', payment.id)
        .where('state', '=', 'fulfillment_pending')
        .where('lease_owner', '=', input.owner)
        .where('fence_token', '=', input.fenceToken.toString())
        .executeTakeFirstOrThrow();
      await insertNotification(transaction, {
        userId: flow.receiver_user_id,
        type: 'nakh_received',
        titleKey: 'notification.nakh_received.title',
        bodyKey: 'notification.nakh_received.body',
        payload: { nakhId: input.nakhId },
        deduplicationKey: `nakh-received:${input.nakhId}`,
        correlationId: payment.id,
        causationId: payment.id,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: input.deliveredEventId,
          aggregate_type: 'nakh',
          aggregate_id: input.nakhId,
          event_type: 'nakh.delivered.v1',
          schema_version: 1,
          payload: { nakhId: input.nakhId, receiverUserId: flow.receiver_user_id },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: payment.id,
          causation_id: payment.id,
        })
        .execute();
      await this.insertTerminalPaymentEvent(
        transaction,
        input.paymentTerminalEventId,
        payment.id,
        'billing.payment-fulfilled.v1',
        now,
      );
      await insertPaymentSuccessNotification(transaction, {
        paymentRecordId: payment.id,
        userId: payment.user_id,
        payload: { nakhId: input.nakhId },
      });
      return {
        paymentRecordId: payment.id,
        outcome: 'fulfilled',
        nakhId: input.nakhId,
        replayed: false,
      };
    });
  }

  /** Claims due work with SKIP LOCKED. The fence token rejects an expired former owner. */
  public async claimFulfillments(
    input: PaymentFulfillmentClaim,
  ): Promise<ClaimedPaymentFulfillment[]> {
    if (
      !OWNER.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 900_000 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new ApplicationError('invalid_request', 'error.billing.fulfillment_lease_invalid', 400);
    return this.database.transaction().execute(async (transaction) => {
      const due = await transaction
        .selectFrom('billing.payment_fulfillments')
        .select('payment_record_id')
        .where('state', 'in', ['receipt_recorded', 'fulfillment_pending'])
        .where('available_at', '<=', sql<Date>`clock_timestamp()`)
        .where((expression) =>
          expression.or([
            expression('lease_expires_at', 'is', null),
            expression('lease_expires_at', '<', sql<Date>`clock_timestamp()`),
          ]),
        )
        .orderBy('available_at', 'asc')
        .orderBy('payment_record_id', 'asc')
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (due.length === 0) return [];
      const claimed = await transaction
        .updateTable('billing.payment_fulfillments')
        .set((expression) => ({
          state: 'fulfillment_pending',
          attempt_count: expression('attempt_count', '+', 1),
          fence_token: expression('fence_token', '+', sql<string>`1`),
          lease_owner: input.owner,
          lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
          updated_at: sql<Date>`clock_timestamp()`,
          version: expression('version', '+', 1),
        }))
        .where(
          'payment_record_id',
          'in',
          due.map(({ payment_record_id: id }) => id),
        )
        .returning(['payment_record_id', 'attempt_count', 'fence_token'])
        .execute();
      return claimed.map((row) => ({
        paymentRecordId: row.payment_record_id,
        attemptCount: row.attempt_count,
        fenceToken: BigInt(row.fence_token),
      }));
    });
  }

  public async releaseFulfillmentForRetry(
    input: PaymentFulfillmentLease & Readonly<{ errorCode: string; delayMs: number }>,
  ): Promise<boolean> {
    this.validateLease(input);
    if (
      !/^[a-z][a-z0-9_]{0,79}$/u.test(input.errorCode) ||
      !Number.isSafeInteger(input.delayMs) ||
      input.delayMs < 0 ||
      input.delayMs > 3_600_000
    )
      throw new ApplicationError('invalid_request', 'error.billing.fulfillment_lease_invalid', 400);
    const updated = await this.database
      .updateTable('billing.payment_fulfillments')
      .set((expression) => ({
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: input.errorCode,
        available_at: sql<Date>`clock_timestamp() + (${input.delayMs} * interval '1 millisecond')`,
        updated_at: sql<Date>`clock_timestamp()`,
        version: expression('version', '+', 1),
      }))
      .where('payment_record_id', '=', input.paymentRecordId)
      .where('state', '=', 'fulfillment_pending')
      .where('lease_owner', '=', input.owner)
      .where('fence_token', '=', input.fenceToken.toString())
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  private async insertTerminalPaymentEvent(
    database: NakhDatabase,
    eventId: string,
    paymentRecordId: string,
    eventType: 'billing.payment-fulfilled.v1' | 'billing.payment-correction-required.v1',
    occurredAt: Date,
  ): Promise<void> {
    await database
      .insertInto('platform.outbox_events')
      .values({
        id: eventId,
        aggregate_type: 'payment_record',
        aggregate_id: paymentRecordId,
        event_type: eventType,
        schema_version: 1,
        payload: { paymentRecordId },
        occurred_at: occurredAt,
        available_at: occurredAt,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: paymentRecordId,
        causation_id: paymentRecordId,
      })
      .execute();
  }

  private validateLease(input: PaymentFulfillmentLease): void {
    if (
      !/^[0-9a-f-]{36}$/u.test(input.paymentRecordId) ||
      !OWNER.test(input.owner) ||
      input.fenceToken < 1n
    )
      throw new ApplicationError('invalid_request', 'error.billing.fulfillment_lease_invalid', 400);
  }

  private async lockProviderEvent(database: NakhDatabase, providerEventId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'telegram-stars:'} || ${providerEventId}, 0))`.execute(
      database,
    );
  }

  private async findPayer(
    database: NakhDatabase,
    telegramUserId: string,
  ): Promise<string | undefined> {
    const row = await database
      .selectFrom('identity.telegram_identities')
      .select('user_id')
      .where('telegram_user_id', '=', telegramUserId)
      .executeTakeFirst();
    return row?.user_id;
  }

  private async findPayment(
    database: NakhDatabase,
    invoicePayload: string,
    lock: boolean,
  ): Promise<StoredPayment | undefined> {
    let digest: string;
    try {
      digest = this.payloads.digest(invoicePayload);
    } catch {
      return undefined;
    }
    let query = database
      .selectFrom('billing.payment_records as payment')
      .innerJoin('billing.pending_payments as intent', 'intent.id', 'payment.pending_payment_id')
      .select([
        'payment.id',
        'payment.user_id',
        'payment.pending_payment_id',
        'payment.status',
        'payment.stars_amount',
        'payment.provider_environment',
        'payment.provider_bot_id_digest',
        'payment.provider_payment_id',
        'payment.version',
        'intent.status as intent_status',
        'intent.reason',
        'intent.target_type',
        'intent.target_id',
        'intent.expires_at',
        'intent.version as intent_version',
      ])
      .where('payment.invoice_payload_digest', '=', digest);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  private async targetAvailable(database: NakhDatabase, payment: StoredPayment): Promise<boolean> {
    if (payment.reason === 'buy_credit_package') {
      const packageRow = await database
        .selectFrom('billing.credit_packages')
        .select('id')
        .where('id', '=', payment.target_id)
        .where('is_active', '=', true)
        .executeTakeFirst();
      const account = await database
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', payment.user_id)
        .where('state', '=', 'active')
        .executeTakeFirst();
      return packageRow !== undefined && account !== undefined;
    }
    if (payment.reason === 'unlock_liked_by_profile') {
      const actionable = await sql<{ id: string }>`
        SELECT incoming.id ${actionableLikedByFrom(payment.user_id)}
        AND incoming.id = ${payment.target_id}::uuid
      `.execute(database);
      return actionable.rows.length === 1;
    }
    if (payment.reason === 'unlock_chat') {
      const match = await database
        .selectFrom('matching.matches as match')
        .innerJoin('matching.match_participants as participant', 'participant.match_id', 'match.id')
        .innerJoin('chat.chat_sessions as chat', 'chat.match_id', 'match.id')
        .innerJoin('interaction.user_pair_states as pair', (join) =>
          join
            .onRef('pair.user_low_id', '=', 'match.user_low_id')
            .onRef('pair.user_high_id', '=', 'match.user_high_id'),
        )
        .select('match.id')
        .where('match.id', '=', payment.target_id)
        .where('participant.user_id', '=', payment.user_id)
        .where('match.status', '=', 'active')
        .where('chat.status', '=', 'active')
        .where('pair.state', '=', 'matched')
        .executeTakeFirst();
      return match !== undefined;
    }
    if (payment.reason === 'send_nakh' && payment.target_type === 'pending_nakh') {
      const pending = await database
        .selectFrom('nakh.pending_nakhes as pending')
        .innerJoin('nakh.nakh_flows as flow', 'flow.id', 'pending.nakh_flow_id')
        .innerJoin('identity.accounts as sender', 'sender.user_id', 'pending.sender_user_id')
        .innerJoin('profile.profiles as sender_profile', 'sender_profile.user_id', 'sender.user_id')
        .innerJoin('identity.accounts as receiver', 'receiver.user_id', 'flow.receiver_user_id')
        .innerJoin(
          'profile.profiles as receiver_profile',
          'receiver_profile.user_id',
          'receiver.user_id',
        )
        .leftJoin('interaction.user_pair_states as pair', (join) =>
          join
            .on(
              'pair.user_low_id',
              '=',
              sql<string>`LEAST(flow.sender_user_id, flow.receiver_user_id)`,
            )
            .on(
              'pair.user_high_id',
              '=',
              sql<string>`GREATEST(flow.sender_user_id, flow.receiver_user_id)`,
            ),
        )
        .select('pending.id')
        .where('pending.id', '=', payment.target_id)
        .where('pending.pending_payment_id', '=', payment.pending_payment_id)
        .where('pending.sender_user_id', '=', payment.user_id)
        .where('pending.status', '=', 'pending_payment')
        .where('sender.state', '=', 'active')
        .where('sender_profile.completion_status', '=', 'complete')
        .where('receiver.state', '=', 'active')
        .where('receiver_profile.completion_status', '=', 'complete')
        .where('pair.state', 'is', null)
        .executeTakeFirst();
      return pending !== undefined;
    }
    return false;
  }

  private async insertProviderEvent(
    database: NakhDatabase,
    input: Readonly<{
      write: TelegramPreCheckoutWrite;
      incomingFactHash: string;
      eventType: 'pre_checkout' | 'successful_payment';
      paymentRecordId?: string;
      payerUserId?: string;
      decision: 'allow' | 'deny' | 'receipt_recorded' | 'quarantined';
      reasonCode?: string;
    }>,
  ): Promise<void> {
    await database
      .insertInto('billing.payment_provider_events')
      .values({
        id: this.ids.uuid(),
        provider: 'telegram_stars',
        provider_event_id: input.write.providerEventId,
        event_type: input.eventType,
        payment_record_id: input.paymentRecordId ?? null,
        payer_user_id: input.payerUserId ?? null,
        fact_hash: input.incomingFactHash,
        raw_payload_digest: input.write.evidence.digest,
        raw_payload_ciphertext: Uint8Array.from(input.write.evidence.ciphertext),
        raw_payload_key_id: input.write.evidence.keyId,
        raw_payload_schema_version: input.write.evidence.schemaVersion,
        decision: input.decision,
        reason_code: input.reasonCode ?? null,
      })
      .execute();
  }

  private async recordConflict(
    database: NakhDatabase,
    write: TelegramPreCheckoutWrite,
    incomingFactHash: string,
    existingFactHash: string | null,
    paymentRecordId: string | null,
    reasonCode: 'event_fact_conflict' | 'payment_fact_mismatch' | 'charge_conflict',
  ): Promise<void> {
    await database
      .insertInto('billing.payment_provider_conflicts')
      .values({
        id: this.ids.uuid(),
        provider: 'telegram_stars',
        provider_event_id: write.providerEventId,
        payment_record_id: paymentRecordId,
        existing_fact_hash: existingFactHash,
        incoming_fact_hash: incomingFactHash,
        reason_code: reasonCode,
        raw_payload_digest: write.evidence.digest,
        raw_payload_ciphertext: Uint8Array.from(write.evidence.ciphertext),
        raw_payload_key_id: write.evidence.keyId,
        raw_payload_schema_version: write.evidence.schemaVersion,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['provider', 'provider_event_id', 'incoming_fact_hash', 'reason_code'])
          .doNothing(),
      )
      .execute();
  }
}
