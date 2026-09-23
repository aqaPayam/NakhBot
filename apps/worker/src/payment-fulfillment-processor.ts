import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type {
  ClaimedPaymentFulfillment,
  PostgresTelegramStarsReceiptStore,
} from '@nakh/persistence-postgres';

type FulfillmentStore = Pick<
  PostgresTelegramStarsReceiptStore,
  | 'claimFulfillments'
  | 'fulfillCreditPackage'
  | 'fulfillDirectPaidAction'
  | 'fulfillPendingNakh'
  | 'releaseFulfillmentForRetry'
>;

export type PaymentFulfillmentPollResult =
  | Readonly<{ outcome: 'idle' }>
  | Readonly<{
      outcome: 'lease_lost';
      paymentType: ClaimedPaymentFulfillment['paymentType'];
    }>
  | Readonly<{
      outcome: 'fulfilled' | 'correction_required';
      paymentType: ClaimedPaymentFulfillment['paymentType'];
    }>
  | Readonly<{
      outcome: 'retry_scheduled';
      paymentType: ClaimedPaymentFulfillment['paymentType'];
      reasonCode: string;
    }>;

function retryDelay(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount - 1, 6));
}

function failureCode(error: unknown): string {
  return error instanceof ApplicationError ? error.code : 'internal_error';
}

function isLeaseLost(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    error.code === 'conflict' &&
    error.message === 'error.billing.fulfillment_lease_lost'
  );
}

/** Routes one fenced, database-authoritative Stars fulfillment without trusting queue payloads. */
export class PaymentFulfillmentProcessor {
  public constructor(
    private readonly store: FulfillmentStore,
    private readonly ids: Pick<IdGenerator, 'uuid'>,
    private readonly owner: string,
  ) {}

  public async processNext(): Promise<PaymentFulfillmentPollResult> {
    const [fulfillment] = await this.store.claimFulfillments({
      owner: this.owner,
      leaseMs: 300_000,
      limit: 1,
    });
    if (fulfillment === undefined) return { outcome: 'idle' };
    return this.processClaim(fulfillment);
  }

  private async processClaim(
    fulfillment: ClaimedPaymentFulfillment,
  ): Promise<PaymentFulfillmentPollResult> {
    const lease = {
      paymentRecordId: fulfillment.paymentRecordId,
      owner: this.owner,
      fenceToken: fulfillment.fenceToken,
    };
    try {
      if (fulfillment.paymentType === 'buy_credit_package') {
        await this.store.fulfillCreditPackage({
          ...lease,
          creditTransactionId: this.ids.uuid(),
          creditIncreasedEventId: this.ids.uuid(),
          paymentFulfilledEventId: this.ids.uuid(),
        });
        return { outcome: 'fulfilled', paymentType: fulfillment.paymentType };
      }
      if (fulfillment.paymentType === 'direct_paid_action') {
        const result = await this.store.fulfillDirectPaidAction({
          ...lease,
          featureUnlockId: this.ids.uuid(),
          refundRecordId: this.ids.uuid(),
          featureUnlockedEventId: this.ids.uuid(),
          paymentTerminalEventId: this.ids.uuid(),
        });
        return { outcome: result.outcome, paymentType: fulfillment.paymentType };
      }
      const result = await this.store.fulfillPendingNakh({
        ...lease,
        nakhId: this.ids.uuid(),
        historyId: this.ids.uuid(),
        refundRecordId: this.ids.uuid(),
        deliveredEventId: this.ids.uuid(),
        paymentTerminalEventId: this.ids.uuid(),
      });
      return { outcome: result.outcome, paymentType: fulfillment.paymentType };
    } catch (error) {
      if (isLeaseLost(error))
        return { outcome: 'lease_lost', paymentType: fulfillment.paymentType };
      const reasonCode = failureCode(error);
      const released = await this.store.releaseFulfillmentForRetry({
        ...lease,
        errorCode: reasonCode,
        delayMs: retryDelay(fulfillment.attemptCount),
      });
      return released
        ? { outcome: 'retry_scheduled', paymentType: fulfillment.paymentType, reasonCode }
        : { outcome: 'lease_lost', paymentType: fulfillment.paymentType };
    }
  }
}
