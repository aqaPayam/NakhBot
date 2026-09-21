import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type {
  AmbiguousStarsRefundResolution,
  AmbiguousStarsRefundResolutionResult,
  AmbiguousStarsRefundResolutionStore,
  ClaimedStarsRefund,
  StarsRefundCompletion,
  StarsRefundFailure,
  StarsRefundLease,
  StarsRefundStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { insertPaymentCorrectionNotification } from './notification-store.js';

export type StarsRefundClaim = Readonly<{ owner: string; leaseMs: number; limit: number }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER = /^[\x20-\x7e]{1,128}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;

function invalidRequest(): never {
  throw new ApplicationError('invalid_request', 'error.billing.refund_invalid', 400);
}

function validateLease(input: StarsRefundLease): void {
  if (
    typeof input.refundRecordId !== 'string' ||
    !UUID.test(input.refundRecordId) ||
    typeof input.owner !== 'string' ||
    !OWNER.test(input.owner) ||
    typeof input.fenceToken !== 'bigint' ||
    input.fenceToken < 1n
  )
    invalidRequest();
}

function validateFailure(input: StarsRefundFailure): void {
  validateLease(input);
  if (
    !ERROR_CODE.test(input.errorCode) ||
    !['retryable_not_sent', 'ambiguous', 'terminal_failure'].includes(input.kind) ||
    (input.kind === 'retryable_not_sent' &&
      (!Number.isSafeInteger(input.delayMs) || input.delayMs! < 0 || input.delayMs! > 3_600_000)) ||
    (input.kind !== 'retryable_not_sent' && input.delayMs !== undefined)
  )
    invalidRequest();
}

/** Durable, fenced persistence for automatic Telegram Stars corrections. */
export class PostgresRefundStore implements StarsRefundStore, AmbiguousStarsRefundResolutionStore {
  public constructor(private readonly database: NakhDatabase) {}

  /** Claims only requests for which Telegram has definitely not been contacted. */
  public async claimStarsRefunds(input: StarsRefundClaim): Promise<ClaimedStarsRefund[]> {
    if (
      typeof input.owner !== 'string' ||
      !OWNER.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 900_000 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      invalidRequest();

    return this.database.transaction().execute(async (transaction) => {
      const due = await transaction
        .selectFrom('billing.refund_records')
        .select('id')
        .where('funding_type', '=', 'telegram_stars')
        .where('status', 'in', ['pending', 'failed_retryable'])
        .where('provider_progress', '=', 'not_started')
        .where('available_at', '<=', sql<Date>`clock_timestamp()`)
        .where((expression) =>
          expression.or([
            expression('lease_expires_at', 'is', null),
            expression('lease_expires_at', '<', sql<Date>`clock_timestamp()`),
          ]),
        )
        .orderBy('available_at', 'asc')
        .orderBy('id', 'asc')
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (due.length === 0) return [];

      const rows = await transaction
        .updateTable('billing.refund_records')
        .set((expression) => ({
          status: 'pending',
          attempt_count: expression('attempt_count', '+', 1),
          fence_token: expression('fence_token', '+', sql<string>`1`),
          lease_owner: input.owner,
          lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
          last_error_code: null,
          failed_at: null,
          updated_at: sql<Date>`clock_timestamp()`,
          version: expression('version', '+', 1),
        }))
        .where(
          'id',
          'in',
          due.map(({ id }) => id),
        )
        .returning([
          'id',
          'payment_record_id',
          'user_id',
          'telegram_charge_id',
          'stars_amount',
          'attempt_count',
          'fence_token',
        ])
        .execute();

      return rows.map((row) => {
        if (
          row.payment_record_id === null ||
          row.telegram_charge_id === null ||
          row.stars_amount === null
        )
          throw new ApplicationError('conflict', 'error.billing.refund_shape_invalid', 409);
        return {
          refundRecordId: row.id,
          paymentRecordId: row.payment_record_id,
          userId: row.user_id,
          telegramChargeId: row.telegram_charge_id,
          starsAmount: BigInt(row.stars_amount),
          attemptCount: row.attempt_count,
          owner: input.owner,
          fenceToken: BigInt(row.fence_token),
        };
      });
    });
  }

  public async beginProviderCall(input: StarsRefundLease): Promise<boolean> {
    validateLease(input);
    const updated = await this.database
      .updateTable('billing.refund_records')
      .set((expression) => ({
        provider_progress: 'call_started',
        updated_at: sql<Date>`clock_timestamp()`,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', input.refundRecordId)
      .where('funding_type', '=', 'telegram_stars')
      .where('status', '=', 'pending')
      .where('provider_progress', '=', 'not_started')
      .where('lease_owner', '=', input.owner)
      .where('fence_token', '=', input.fenceToken.toString())
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  public async completeStarsRefund(input: StarsRefundLease): Promise<StarsRefundCompletion> {
    validateLease(input);
    return this.database.transaction().execute(async (transaction) => {
      const refund = await transaction
        .selectFrom('billing.refund_records')
        .selectAll()
        .select(sql<Date>`transaction_timestamp()`.as('database_now'))
        .where('id', '=', input.refundRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (refund === undefined)
        throw new ApplicationError('not_found', 'error.billing.refund_not_found', 404);
      if (refund.status === 'processed') return 'replayed';
      if (
        refund.funding_type !== 'telegram_stars' ||
        refund.status !== 'pending' ||
        refund.provider_progress !== 'call_started' ||
        refund.lease_owner !== input.owner ||
        BigInt(refund.fence_token) !== input.fenceToken ||
        refund.lease_expires_at === null ||
        refund.lease_expires_at <= refund.database_now ||
        refund.payment_record_id === null
      )
        return 'lease_lost';

      const payment = await transaction
        .selectFrom('billing.payment_records')
        .select(['id', 'user_id', 'status'])
        .where('id', '=', refund.payment_record_id)
        .forUpdate()
        .executeTakeFirst();
      const fulfillment = await transaction
        .selectFrom('billing.payment_fulfillments')
        .select(['payment_record_id', 'state'])
        .where('payment_record_id', '=', refund.payment_record_id)
        .forUpdate()
        .executeTakeFirst();
      if (
        payment === undefined ||
        payment.user_id !== refund.user_id ||
        payment.status !== 'paid' ||
        fulfillment?.state !== 'correction_required'
      )
        throw new ApplicationError('conflict', 'error.billing.refund_state_invalid', 409);

      const now = refund.database_now;
      await transaction
        .updateTable('billing.refund_records')
        .set((expression) => ({
          status: 'processed',
          provider_progress: 'refund_confirmed',
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: null,
          processed_at: now,
          failed_at: null,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', refund.id)
        .where('status', '=', 'pending')
        .where('lease_owner', '=', input.owner)
        .where('fence_token', '=', input.fenceToken.toString())
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.payment_records')
        .set((expression) => ({
          status: 'refunded',
          refunded_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', payment.id)
        .where('status', '=', 'paid')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.payment_fulfillments')
        .set((expression) => ({
          state: 'corrected',
          corrected_at: now,
          last_error_code: null,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('payment_record_id', '=', payment.id)
        .where('state', '=', 'correction_required')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: randomUUID(),
          aggregate_type: 'payment_record',
          aggregate_id: payment.id,
          event_type: 'billing.payment-corrected.v1',
          schema_version: 1,
          payload: { paymentRecordId: payment.id, refundRecordId: refund.id },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: payment.id,
          causation_id: refund.id,
        })
        .execute();
      await insertPaymentCorrectionNotification(transaction, {
        paymentRecordId: payment.id,
        refundRecordId: refund.id,
        userId: payment.user_id,
      });
      return 'processed';
    });
  }

  public async recordProviderFailure(input: StarsRefundFailure): Promise<boolean> {
    validateFailure(input);
    const retryable = input.kind !== 'terminal_failure';
    const definitelyNotSent = input.kind === 'retryable_not_sent';
    const updated = await this.database
      .updateTable('billing.refund_records')
      .set((expression) => ({
        status: retryable ? 'failed_retryable' : 'failed_terminal',
        provider_progress: definitelyNotSent ? 'not_started' : 'call_started',
        available_at: definitelyNotSent
          ? sql<Date>`clock_timestamp() + (${input.delayMs!} * interval '1 millisecond')`
          : sql<Date>`clock_timestamp()`,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: input.errorCode,
        failed_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`clock_timestamp()`,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', input.refundRecordId)
      .where('funding_type', '=', 'telegram_stars')
      .where('status', '=', 'pending')
      .where('provider_progress', '=', 'call_started')
      .where('lease_owner', '=', input.owner)
      .where('fence_token', '=', input.fenceToken.toString())
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  public async resolveAmbiguousStarsRefund(
    input: AmbiguousStarsRefundResolution,
  ): Promise<AmbiguousStarsRefundResolutionResult> {
    if (
      input.actor.kind !== 'admin' ||
      !UUID.test(input.actor.userId) ||
      !UUID.test(input.refundRecordId) ||
      !UUID.test(input.requestId) ||
      !UUID.test(input.commandId) ||
      !UUID.test(input.auditId) ||
      !UUID.test(input.eventId) ||
      !/^[a-f0-9]{64}$/u.test(input.evidenceDigest) ||
      !['refunded', 'not_refunded', 'terminal_failure'].includes(input.observedOutcome)
    )
      invalidRequest();

    return this.database.transaction().execute(async (transaction) => {
      const admin = await transaction
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', input.actor.userId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (admin === undefined)
        throw new ApplicationError('forbidden', 'error.billing.refund_resolution_forbidden', 403);

      const refund = await transaction
        .selectFrom('billing.refund_records')
        .selectAll()
        .select(sql<Date>`transaction_timestamp()`.as('database_now'))
        .where('id', '=', input.refundRecordId)
        .forUpdate()
        .executeTakeFirst();
      if (refund === undefined)
        throw new ApplicationError('not_found', 'error.billing.refund_not_found', 404);

      const priorAudit = await transaction
        .selectFrom('platform.audit_logs')
        .select(['actor_admin_id', 'subject_id', 'result_code', 'metadata'])
        .where('command_id', '=', input.commandId)
        .where('event_type', '=', 'billing.ambiguous-refund-resolved.v1')
        .executeTakeFirst();
      if (priorAudit !== undefined) {
        const metadata = priorAudit.metadata;
        if (
          priorAudit.actor_admin_id !== admin.id ||
          priorAudit.subject_id !== input.refundRecordId ||
          priorAudit.result_code !== input.observedOutcome ||
          metadata.evidenceDigest !== input.evidenceDigest
        )
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        return {
          outcome:
            input.observedOutcome === 'refunded'
              ? 'corrected'
              : input.observedOutcome === 'not_refunded'
                ? 'retry_scheduled'
                : 'terminal_failure',
          replayed: true,
        };
      }

      if (
        refund.funding_type !== 'telegram_stars' ||
        refund.status !== 'failed_retryable' ||
        refund.provider_progress !== 'call_started' ||
        refund.lease_owner !== null ||
        refund.payment_record_id === null
      )
        throw new ApplicationError('conflict', 'error.billing.refund_not_ambiguous', 409);

      const now = refund.database_now;
      let outcome: AmbiguousStarsRefundResolutionResult['outcome'];
      if (input.observedOutcome === 'refunded') {
        const payment = await transaction
          .selectFrom('billing.payment_records')
          .select(['id', 'user_id', 'status'])
          .where('id', '=', refund.payment_record_id)
          .forUpdate()
          .executeTakeFirst();
        const fulfillment = await transaction
          .selectFrom('billing.payment_fulfillments')
          .select('state')
          .where('payment_record_id', '=', refund.payment_record_id)
          .forUpdate()
          .executeTakeFirst();
        if (
          payment === undefined ||
          payment.user_id !== refund.user_id ||
          payment.status !== 'paid' ||
          fulfillment?.state !== 'correction_required'
        )
          throw new ApplicationError('conflict', 'error.billing.refund_state_invalid', 409);
        await transaction
          .updateTable('billing.refund_records')
          .set((expression) => ({
            status: 'processed',
            provider_progress: 'refund_confirmed',
            last_error_code: null,
            processed_at: now,
            failed_at: null,
            updated_at: now,
            version: expression('version', '+', 1),
          }))
          .where('id', '=', refund.id)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('billing.payment_records')
          .set((expression) => ({
            status: 'refunded',
            refunded_at: now,
            version: expression('version', '+', 1),
          }))
          .where('id', '=', payment.id)
          .where('status', '=', 'paid')
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('billing.payment_fulfillments')
          .set((expression) => ({
            state: 'corrected',
            corrected_at: now,
            last_error_code: null,
            updated_at: now,
            version: expression('version', '+', 1),
          }))
          .where('payment_record_id', '=', payment.id)
          .where('state', '=', 'correction_required')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: input.eventId,
            aggregate_type: 'payment_record',
            aggregate_id: payment.id,
            event_type: 'billing.payment-corrected.v1',
            schema_version: 1,
            payload: { paymentRecordId: payment.id, refundRecordId: refund.id },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: input.requestId,
            causation_id: input.commandId,
          })
          .execute();
        await insertPaymentCorrectionNotification(transaction, {
          paymentRecordId: payment.id,
          refundRecordId: refund.id,
          userId: payment.user_id,
        });
        outcome = 'corrected';
      } else {
        const terminal = input.observedOutcome === 'terminal_failure';
        await transaction
          .updateTable('billing.refund_records')
          .set((expression) => ({
            status: terminal ? 'failed_terminal' : 'failed_retryable',
            provider_progress: terminal ? 'call_started' : 'not_started',
            available_at: now,
            last_error_code: terminal
              ? 'provider_refund_rejected'
              : 'provider_confirmed_not_refunded',
            failed_at: now,
            updated_at: now,
            version: expression('version', '+', 1),
          }))
          .where('id', '=', refund.id)
          .executeTakeFirstOrThrow();
        outcome = terminal ? 'terminal_failure' : 'retry_scheduled';
      }

      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: input.auditId,
          category: 'admin',
          event_type: 'billing.ambiguous-refund-resolved.v1',
          actor_type: 'admin',
          actor_user_id: null,
          actor_admin_id: admin.id,
          subject_type: 'refund_record',
          subject_id: refund.id,
          result_code: input.observedOutcome,
          metadata_schema_version: 1,
          metadata: {
            observedOutcome: input.observedOutcome,
            evidenceDigest: input.evidenceDigest,
          },
          request_id: input.requestId,
          command_id: input.commandId,
          occurred_at: now,
        })
        .execute();
      return { outcome, replayed: false };
    });
  }
}
