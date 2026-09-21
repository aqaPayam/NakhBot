import { describe, expect, it, vi } from 'vitest';

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

function harness() {
  const store = {
    beginProviderCall: vi.fn().mockResolvedValue(true),
    completeStarsRefund: vi.fn().mockResolvedValue('processed'),
    recordProviderFailure: vi.fn().mockResolvedValue(true),
  } as unknown as StarsRefundStore;
  const provider = {
    refund: vi.fn().mockResolvedValue({ outcome: 'succeeded' }),
  } as unknown as TelegramStarsRefundProvider;
  return {
    store,
    provider,
    handler: new ProcessTelegramStarsRefundHandler(store, provider, 12_000),
  };
}

describe('M4 Telegram Stars refund processor', () => {
  it('never contacts Telegram until call_started is durable', async () => {
    const { store, provider, handler } = harness();
    vi.mocked(store.beginProviderCall).mockResolvedValue(false);
    await expect(handler.execute(refund)).resolves.toEqual({ outcome: 'lease_lost' });
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('finalizes only a known provider success', async () => {
    const { store, provider, handler } = harness();
    await expect(handler.execute(refund)).resolves.toEqual({ outcome: 'processed' });
    expect(provider.refund).toHaveBeenCalledWith({
      refundRecordId: refund.refundRecordId,
      telegramChargeId: refund.telegramChargeId,
      starsAmount: refund.starsAmount,
    });
    expect(store.completeStarsRefund).toHaveBeenCalledWith(refund);
  });

  it('makes a definitely-unsent request retryable', async () => {
    const { store, provider, handler } = harness();
    vi.mocked(provider.refund).mockResolvedValue({
      outcome: 'retryable_not_sent',
      errorCode: 'provider_unavailable',
    });
    await expect(handler.execute(refund)).resolves.toEqual({ outcome: 'retryable' });
    expect(store.recordProviderFailure).toHaveBeenCalledWith({
      ...refund,
      kind: 'retryable_not_sent',
      errorCode: 'provider_unavailable',
      delayMs: 12_000,
    });
    expect(store.completeStarsRefund).not.toHaveBeenCalled();
  });

  it('quarantines a thrown or explicitly ambiguous provider outcome', async () => {
    const { store, provider, handler } = harness();
    vi.mocked(provider.refund).mockRejectedValue(new Error('timeout after request write'));
    await expect(handler.execute(refund)).resolves.toEqual({
      outcome: 'reconciliation_required',
    });
    expect(store.recordProviderFailure).toHaveBeenCalledWith({
      ...refund,
      kind: 'ambiguous',
      errorCode: 'provider_outcome_unknown',
    });
    expect(store.completeStarsRefund).not.toHaveBeenCalled();
  });
});
