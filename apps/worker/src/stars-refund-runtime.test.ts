import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import {
  createTelegramStarsRefundRuntime,
  TelegramStarsRefundClient,
} from './stars-refund-runtime.js';

const token = `12345:${'a'.repeat(24)}`,
  authority = { telegramUserId: '123456', telegramChargeId: 'original-charge' };
describe('Stars refund provider boundary', () => {
  it('sends only the exact original payer and charge, and accepts a definite provider acknowledgement', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: true }));
    expect(await new TelegramStarsRefundClient(token, request).refund(authority)).toEqual({
      outcome: 'succeeded',
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${token}/refundStarPayment`);
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ user_id: 123456, telegram_payment_charge_id: 'original-charge' }),
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    () => Response.json({ ok: false, description: 'private provider error' }, { status: 400 }),
    () => Response.json({ ok: true, result: false }),
    () => Response.json({ ok: true, result: 'true' }),
    () => new Response('invalid private JSON'),
    () => new Response('x'.repeat(16385)),
    () => new Response('{}', { headers: { 'content-length': '9999999' } }),
  ])(
    'quarantines an unknown result without returning private response details',
    async (response) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response());
      expect(await new TelegramStarsRefundClient(token, request).refund(authority)).toEqual({
        outcome: 'ambiguous',
        errorCode: 'provider_outcome_unknown',
      });
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it('does not retry lost provider acknowledgement and rejects invalid authority before sending', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('private-token-provider-detail'));
    const client = new TelegramStarsRefundClient(token, request);
    expect(await client.refund(authority)).toEqual({
      outcome: 'ambiguous',
      errorCode: 'provider_outcome_unknown',
    });
    expect(await client.refund({ ...authority, telegramUserId: '0' })).toEqual({
      outcome: 'retryable_not_sent',
      errorCode: 'refund_authority_unavailable',
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it('constructs no secrets or stores while refund delivery is disabled', () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('Unexpected secret');
    });
    expect(
      createTelegramStarsRefundRuntime({
        config: { telegram: { starsRefundsEnabled: false } } as AppConfig,
        database: {} as NakhDatabase,
        owner: 'test-worker',
        resolveSecret,
      }),
    ).toBeUndefined();
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
