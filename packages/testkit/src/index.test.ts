import { describe, expect, it } from 'vitest';

import { FakeMediaStore, FakePaymentProvider, FakeTelegramClient } from './index.js';

describe('provider fakes', () => {
  it('record deterministic provider effects', async () => {
    const telegram = new FakeTelegramClient();
    const payment = new FakePaymentProvider();
    const media = new FakeMediaStore();

    await telegram.sendText({ deliveryId: 'd', telegramUserId: '1', text: 'message' });
    await payment.createInvoice({ paymentId: 'p', stars: 2, payload: 'opaque' });
    await media.put({ key: 'k', body: new Uint8Array([1]), contentType: 'image/jpeg' });

    expect(telegram.sent).toHaveLength(1);
    expect(payment.invoices).toHaveLength(1);
    await expect(media.exists({ key: 'k' })).resolves.toBe(true);
  });
});
