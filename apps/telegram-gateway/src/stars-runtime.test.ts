import { describe, expect, it, vi } from 'vitest';
import { TelegramStarsClient, createTelegramStarsRuntime } from './stars-runtime.js';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';

const token = `12345:${'a'.repeat(24)}`;
const payload = 'a'.repeat(32);
function receipt(chatId = 123, currency = 'XTR', amount = 2): Record<string, unknown> {
  return {
    message_id: 1,
    chat: { id: chatId, type: 'private' },
    from: { id: 12345, is_bot: true },
    invoice: { currency, total_amount: amount },
  };
}
describe('Telegram Stars transport', () => {
  it('sends one fixed two-Star price and a forwarded-invoice start parameter', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: receipt() }));
    await new TelegramStarsClient(token, fetcher).invoice(
      '123',
      'Nakh',
      'Costs 2 Stars',
      payload,
      2n,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendInvoice`);
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      chat_id: '123',
      title: 'Nakh',
      description: 'Costs 2 Stars',
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Nakh', amount: 2 }],
      start_parameter: payload,
    });
  });
  it.each([
    receipt(456),
    receipt(123, 'USD'),
    receipt(123, 'XTR', 3),
    { ...receipt(), from: { id: 555, is_bot: true } },
    { ...receipt(), chat: { id: 123, type: 'group' } },
  ])('rejects an acknowledgement for another owner, bot, currency or amount', async (result) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result }));
    await expect(
      new TelegramStarsClient(token, fetcher).invoice('123', 'Nakh', '2 Stars', payload, 2n),
    ).rejects.toMatchObject({ status: 502 });
  });
  it('sanitizes network and provider failures without copying secrets or response data', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error(token)),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ok: false, description: token }, { status: 401 })),
    ]) {
      const error = await new TelegramStarsClient(token, fetcher)
        .invoice('123', 'Nakh', '2 Stars', payload, 2n)
        .catch((e: unknown) => e);
      expect(String(error)).not.toContain(token);
      expect(error).toMatchObject({ status: 502 });
    }
  });
  it('rejects a forged price before contacting Telegram', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new TelegramStarsClient(token, fetcher).invoice('123', 'Nakh', '2 Stars', payload, 3n),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires Telegram to acknowledge a pre-checkout answer', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: false }));
    const client = new TelegramStarsClient(token, fetcher);
    await client.answer('checkout-1', false, 'Payment unavailable');
    const body = fetcher.mock.calls[0]![1]?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({
      pre_checkout_query_id: 'checkout-1',
      ok: false,
      error_message: 'Payment unavailable',
    });
    await expect(client.answer('checkout-2', true, '')).rejects.toMatchObject({ status: 503 });
  });
  it('keeps disabled payment ingress retryable and resolves no secrets', async () => {
    const resolveSecret = vi.fn<() => string>();
    const runtime = createTelegramStarsRuntime({
      config: { telegram: { starsEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      resolveSecret,
    });
    expect(await runtime.handle({ update_id: 1, message: { text: '/start' } })).toBe('unhandled');
    for (const update of [{ pre_checkout_query: {} }, { message: { successful_payment: {} } }])
      await expect(runtime.handle(update)).rejects.toMatchObject({ status: 503 });
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
