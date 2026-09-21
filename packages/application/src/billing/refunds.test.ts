import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  ProcessTelegramStarsRefundHandler,
  type ClaimedStarsRefund,
  type StarsRefundStore,
  type TelegramStarsRefundProvider,
} from './refunds.js';

const refund: ClaimedStarsRefund = {
  refundRecordId: '8ff62428-190f-49da-a1b3-86607a573844',
  paymentRecordId: '61f7fd5b-2cad-45fa-b3b7-e636779a9fd9',
  userId: 'ef9a729c-cafc-4509-8620-ec74bbd02979',
  telegramChargeId: 'telegram-charge-1',
  starsAmount: 15n,
  owner: 'refund-worker-1',
  fenceToken: 1n,
  attemptCount: 1,
};

type RefundHarness = Readonly<{
  handler: ProcessTelegramStarsRefundHandler;
  beginProviderCall: Mock<StarsRefundStore['beginProviderCall']>;
  completeStarsRefund: Mock<StarsRefundStore['completeStarsRefund']>;
  recordProviderFailure: Mock<StarsRefundStore['recordProviderFailure']>;
  refundProvider: Mock<TelegramStarsRefundProvider['refund']>;
}>;

function harness(): RefundHarness {
  const beginProviderCall = vi.fn<StarsRefundStore['beginProviderCall']>().mockResolvedValue(true);
  const completeStarsRefund = vi
    .fn<StarsRefundStore['completeStarsRefund']>()
    .mockResolvedValue('processed');
  const recordProviderFailure = vi
    .fn<StarsRefundStore['recordProviderFailure']>()
    .mockResolvedValue(true);
  const store = {
    beginProviderCall,
    completeStarsRefund,
    recordProviderFailure,
  } satisfies StarsRefundStore;
  const refundProvider = vi
    .fn<TelegramStarsRefundProvider['refund']>()
    .mockResolvedValue({ outcome: 'succeeded' });
  const provider = { refund: refundProvider } satisfies TelegramStarsRefundProvider;
  return {
    beginProviderCall,
    completeStarsRefund,
    recordProviderFailure,
    refundProvider,
    handler: new ProcessTelegramStarsRefundHandler(store, provider, 12_000),
  };
}

describe('M4 Telegram Stars refund processor', () => {
  it('never contacts Telegram until call_started is durable', async () => {
    const { beginProviderCall, refundProvider, handler } = harness();
    beginProviderCall.mockResolvedValue(false);
    await expect(handler.execute(refund)).resolves.toEqual({ outcome: 'lease_lost' });
    expect(refundProvider).not.toHaveBeenCalled();
  });

  it('finalizes only a known provider success', async () => {
    const { completeStarsRefund, refundProvider, handler } = harness();
    await expect(handler.execute(refund)).resolves.toEqual({ outcome: 'processed' });
    expect(refundProvider).toHaveBeenCalledWith({
      refundRecordId: refund.refundRecordId,
      telegramChargeId: refund.telegramChargeId,
      starsAmount: refund.starsAmount,
    });
    expect(completeStarsRefund).toHaveBeenCalledWith(refund);
  });

  it('makes a definitely-unsent request retryable', async () => {
    const { completeStarsRefund, recordProviderFailure, refundProvider, handler } = harness();
    refundProvider.mockResolvedValue({
      outcome: 'retryable_not_sent',
      errorCode: 'provider_unavailable',
    });
    await expect(handler.execute(refund)).resolves.toEqual({ outcome: 'retryable' });
    expect(recordProviderFailure).toHaveBeenCalledWith({
      ...refund,
      kind: 'retryable_not_sent',
      errorCode: 'provider_unavailable',
      delayMs: 12_000,
    });
    expect(completeStarsRefund).not.toHaveBeenCalled();
  });

  it('quarantines a thrown or explicitly ambiguous provider outcome', async () => {
    const { completeStarsRefund, recordProviderFailure, refundProvider, handler } = harness();
    refundProvider.mockRejectedValue(new Error('timeout after request write'));
    await expect(handler.execute(refund)).resolves.toEqual({
      outcome: 'reconciliation_required',
    });
    expect(recordProviderFailure).toHaveBeenCalledWith({
      ...refund,
      kind: 'ambiguous',
      errorCode: 'provider_outcome_unknown',
    });
    expect(completeStarsRefund).not.toHaveBeenCalled();
  });
});
