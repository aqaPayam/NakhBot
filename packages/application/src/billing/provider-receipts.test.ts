import { describe, expect, it, vi } from 'vitest';

import {
  RecordTelegramSuccessfulPaymentHandler,
  ValidateTelegramPreCheckoutHandler,
  type TelegramStarsReceiptStore,
} from './provider-receipts.js';

const evidence = {
  digest: 'a'.repeat(64),
  ciphertext: Uint8Array.from({ length: 32 }, () => 1),
  keyId: 'provider-v1',
  schemaVersion: 1,
};
const callback = {
  providerEventId: 'update:100:pre-checkout',
  telegramUserId: '123456789',
  invoicePayload: 'a'.repeat(32),
  currency: 'XTR',
  totalAmount: 10n,
  providerEnvironment: 'test' as const,
  providerBotIdDigest: 'b'.repeat(64),
  evidence,
};

describe('M4 Telegram Stars provider receipt handlers', () => {
  it('returns a pre-checkout decision only after the store resolves', async () => {
    const validatePreCheckout = vi.fn().mockResolvedValue({ allowed: true, replayed: false });
    const store = {
      validatePreCheckout,
      recordSuccessfulPayment: vi.fn(),
    } as unknown as TelegramStarsReceiptStore;
    await expect(new ValidateTelegramPreCheckoutHandler(store).execute(callback)).resolves.toEqual({
      allowed: true,
      replayed: false,
    });
    expect(validatePreCheckout).toHaveBeenCalledWith(callback);
  });

  it('does not hide a quarantined captured payment from the adapter', async () => {
    const recordSuccessfulPayment = vi.fn().mockResolvedValue({
      outcome: 'quarantined',
      reasonCode: 'payment_fact_mismatch',
    });
    const store = {
      validatePreCheckout: vi.fn(),
      recordSuccessfulPayment,
    } as unknown as TelegramStarsReceiptStore;
    const write = { ...callback, telegramChargeId: 'telegram-charge-1' };
    await expect(
      new RecordTelegramSuccessfulPaymentHandler(store).execute(write),
    ).resolves.toMatchObject({ outcome: 'quarantined' });
    expect(recordSuccessfulPayment).toHaveBeenCalledWith(write);
  });
});
