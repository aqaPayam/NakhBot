import { sql } from 'kysely';
import type { ClaimedStarsRefund } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import type { TelegramStarsKeys } from './telegram-stars-keys.js';

export type StarsRefundProviderScope = Readonly<{
  environment: 'local' | 'test' | 'staging' | 'production';
  botIdDigest: string;
}>;
export type StarsRefundProviderAuthority = Readonly<{
  telegramUserId: string;
  telegramChargeId: string;
}>;

/** Original retained financial authority is independent of current identity,
 * product life and session grants. Called after fenced beginProviderCall. */
export class PostgresStarsRefundAuthorityStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly keys: TelegramStarsKeys,
  ) {}

  public async resolve(
    input: ClaimedStarsRefund,
    provider: StarsRefundProviderScope,
  ): Promise<StarsRefundProviderAuthority | undefined> {
    const claim = Object.freeze({ ...input }),
      scope = Object.freeze({ ...provider });
    return this.database.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('billing.refund_records as refund')
        .innerJoin('billing.payment_records as payment', 'payment.id', 'refund.payment_record_id')
        .innerJoin(
          'billing.telegram_stars_receipts as receipt',
          'receipt.payment_record_id',
          'payment.id',
        )
        .innerJoin('billing.payment_provider_events as event', (join) =>
          join
            .onRef('event.provider_event_id', '=', 'receipt.provider_event_id')
            .onRef('event.payment_record_id', '=', 'payment.id'),
        )
        .select([
          'payment.user_id',
          'payment.stars_amount',
          'payment.invoice_payload_digest',
          'payment.invoice_payload_ciphertext',
          'payment.invoice_payload_key_id',
          'receipt.provider_event_id',
          'receipt.telegram_charge_id',
          'receipt.provider_charge_id',
          'receipt.payer_user_id',
          'receipt.stars_amount as receiptAmount',
          'event.raw_payload_ciphertext',
          'event.raw_payload_digest',
          'event.raw_payload_key_id',
        ])
        .where('refund.id', '=', claim.refundRecordId)
        .where('refund.payment_record_id', '=', claim.paymentRecordId)
        .where('refund.user_id', '=', claim.userId)
        .where('refund.funding_type', '=', 'telegram_stars')
        .where('refund.status', '=', 'pending')
        .where('refund.provider_progress', '=', 'call_started')
        .where('refund.lease_owner', '=', claim.owner)
        .where('refund.fence_token', '=', claim.fenceToken.toString())
        .where('refund.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .where('refund.telegram_charge_id', '=', claim.telegramChargeId)
        .where('refund.stars_amount', '=', claim.starsAmount.toString())
        .where('payment.provider', '=', 'telegram_stars')
        .where('payment.status', '=', 'paid')
        .where('payment.provider_environment', '=', scope.environment)
        .where('payment.provider_bot_id_digest', '=', scope.botIdDigest)
        .where('event.provider', '=', 'telegram_stars')
        .where('event.event_type', '=', 'successful_payment')
        .where('event.decision', '=', 'receipt_recorded')
        .where('event.raw_payload_schema_version', '=', 1)
        .where('event.payer_user_id', '=', claim.userId)
        .forShare()
        .executeTakeFirst();
      if (
        row === undefined ||
        row.user_id !== claim.userId ||
        row.payer_user_id !== claim.userId ||
        row.telegram_charge_id !== claim.telegramChargeId ||
        row.stars_amount !== claim.starsAmount.toString() ||
        row.receiptAmount !== row.stars_amount
      )
        return undefined;
      const facts = this.keys.verifyEvidence(
        row.raw_payload_ciphertext,
        row.raw_payload_key_id,
        row.raw_payload_digest,
      );
      const expectedKeys = [
        'botDigest',
        'currency',
        'environment',
        'eventType',
        'invoicePayload',
        'providerEventId',
        'telegramChargeId',
        'telegramUserId',
        'totalAmount',
        ...(row.provider_charge_id === null ? [] : ['providerChargeId']),
      ].sort();
      if (
        Object.keys(facts).sort().join(',') !== expectedKeys.join(',') ||
        facts.eventType !== 'successful_payment' ||
        facts.providerEventId !== row.provider_event_id ||
        facts.currency !== 'XTR' ||
        facts.totalAmount !== row.stars_amount ||
        facts.environment !== scope.environment ||
        facts.botDigest !== scope.botIdDigest ||
        facts.telegramChargeId !== row.telegram_charge_id ||
        (facts.providerChargeId ?? null) !== row.provider_charge_id ||
        typeof facts.telegramUserId !== 'string' ||
        !/^[1-9][0-9]{0,19}$/u.test(facts.telegramUserId) ||
        !Number.isSafeInteger(Number(facts.telegramUserId)) ||
        typeof facts.invoicePayload !== 'string' ||
        this.keys.digest(facts.invoicePayload) !== row.invoice_payload_digest ||
        this.keys.reveal(row.invoice_payload_ciphertext, row.invoice_payload_key_id) !==
          facts.invoicePayload
      )
        return undefined;
      return Object.freeze({
        telegramUserId: facts.telegramUserId,
        telegramChargeId: row.telegram_charge_id,
      });
    });
  }
}
