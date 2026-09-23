import { ApplicationError } from '@nakh/domain';
import type { ClaimedPaymentFulfillment } from '@nakh/persistence-postgres';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { PaymentFulfillmentProcessor } from './payment-fulfillment-processor.js';

const paymentRecordId = '10000000-0000-4000-8000-000000000000';
const generatedIds = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000005',
];

type Store = Readonly<{
  claimFulfillments: Mock;
  fulfillCreditPackage: Mock;
  fulfillDirectPaidAction: Mock;
  fulfillPendingNakh: Mock;
  releaseFulfillmentForRetry: Mock;
}>;

function claim(
  paymentType: ClaimedPaymentFulfillment['paymentType'],
  attemptCount = 1,
): ClaimedPaymentFulfillment {
  return { paymentRecordId, paymentType, attemptCount, fenceToken: 7n };
}

function fixture(claimed?: ClaimedPaymentFulfillment): Readonly<{
  processor: PaymentFulfillmentProcessor;
  store: Store;
}> {
  const store = {
    claimFulfillments: vi.fn().mockResolvedValue(claimed === undefined ? [] : [claimed]),
    fulfillCreditPackage: vi.fn().mockResolvedValue({ outcome: 'fulfilled' }),
    fulfillDirectPaidAction: vi.fn().mockResolvedValue({ outcome: 'fulfilled' }),
    fulfillPendingNakh: vi.fn().mockResolvedValue({ outcome: 'fulfilled' }),
    releaseFulfillmentForRetry: vi.fn().mockResolvedValue(true),
  };
  let nextId = 0;
  const processor = new PaymentFulfillmentProcessor(
    store,
    { uuid: () => generatedIds[nextId++]! },
    'payment-worker-one',
  );
  return { processor, store };
}

describe('payment fulfillment processor', () => {
  it('does no work when no captured payment is due', async () => {
    const { processor, store } = fixture();
    await expect(processor.processNext()).resolves.toEqual({ outcome: 'idle' });
    expect(store.claimFulfillments).toHaveBeenCalledWith({
      owner: 'payment-worker-one',
      leaseMs: 300_000,
      limit: 1,
    });
    expect(store.fulfillCreditPackage).not.toHaveBeenCalled();
  });

  it('routes a package purchase with unique durable fact identifiers', async () => {
    const { processor, store } = fixture(claim('buy_credit_package'));
    await expect(processor.processNext()).resolves.toEqual({
      outcome: 'fulfilled',
      paymentType: 'buy_credit_package',
    });
    expect(store.fulfillCreditPackage).toHaveBeenCalledWith({
      paymentRecordId,
      owner: 'payment-worker-one',
      fenceToken: 7n,
      creditTransactionId: generatedIds[0],
      creditIncreasedEventId: generatedIds[1],
      paymentFulfilledEventId: generatedIds[2],
    });
  });

  it('routes a direct action and reports a durable correction', async () => {
    const { processor, store } = fixture(claim('direct_paid_action'));
    store.fulfillDirectPaidAction.mockResolvedValue({ outcome: 'correction_required' });
    await expect(processor.processNext()).resolves.toEqual({
      outcome: 'correction_required',
      paymentType: 'direct_paid_action',
    });
    expect(store.fulfillDirectPaidAction).toHaveBeenCalledWith({
      paymentRecordId,
      owner: 'payment-worker-one',
      fenceToken: 7n,
      featureUnlockId: generatedIds[0],
      refundRecordId: generatedIds[1],
      featureUnlockedEventId: generatedIds[2],
      paymentTerminalEventId: generatedIds[3],
    });
  });

  it('routes a Pending Nakh through its captured-Stars transaction', async () => {
    const { processor, store } = fixture(claim('pay_pending_action'));
    await expect(processor.processNext()).resolves.toEqual({
      outcome: 'fulfilled',
      paymentType: 'pay_pending_action',
    });
    expect(store.fulfillPendingNakh).toHaveBeenCalledWith({
      paymentRecordId,
      owner: 'payment-worker-one',
      fenceToken: 7n,
      nakhId: generatedIds[0],
      historyId: generatedIds[1],
      refundRecordId: generatedIds[2],
      deliveredEventId: generatedIds[3],
      paymentTerminalEventId: generatedIds[4],
    });
  });

  it('releases unexpected failures with sanitized exponential backoff', async () => {
    const { processor, store } = fixture(claim('buy_credit_package', 3));
    store.fulfillCreditPackage.mockRejectedValue(new Error('sensitive database detail'));
    await expect(processor.processNext()).resolves.toEqual({
      outcome: 'retry_scheduled',
      paymentType: 'buy_credit_package',
      reasonCode: 'internal_error',
    });
    expect(store.releaseFulfillmentForRetry).toHaveBeenCalledWith({
      paymentRecordId,
      owner: 'payment-worker-one',
      fenceToken: 7n,
      errorCode: 'internal_error',
      delayMs: 4_000,
    });
  });

  it('does not release a claim whose fenced lease was lost', async () => {
    const { processor, store } = fixture(claim('pay_pending_action'));
    store.fulfillPendingNakh.mockRejectedValue(
      new ApplicationError('conflict', 'error.billing.fulfillment_lease_lost', 409),
    );
    await expect(processor.processNext()).resolves.toEqual({ outcome: 'lease_lost' });
    expect(store.releaseFulfillmentForRetry).not.toHaveBeenCalled();
  });

  it('reports lease loss when retry release loses its fence', async () => {
    const { processor, store } = fixture(claim('direct_paid_action'));
    store.fulfillDirectPaidAction.mockRejectedValue(
      new ApplicationError('payment_verification_failed', 'error.billing.payment_mismatch', 409),
    );
    store.releaseFulfillmentForRetry.mockResolvedValue(false);
    await expect(processor.processNext()).resolves.toEqual({ outcome: 'lease_lost' });
  });
});
