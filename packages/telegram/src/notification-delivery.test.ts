import { describe, expect, it, vi } from 'vitest';

import { renderTelegramNotification, TelegramNotificationSender } from './notification-delivery.js';

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('M6 Telegram notification sender', () => {
  it('escapes catalog text before enabling Telegram HTML rendering', () => {
    expect(renderTelegramNotification('A < B', 'Use & stay > safe')).toBe(
      '<b>A &lt; B</b>\nUse &amp; stay &gt; safe',
    );
  });

  it('returns only an opaque known-success message key', async () => {
    const fetcher = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(response({ ok: true, result: { message_id: 42 } }));
    const sender = new TelegramNotificationSender('secret-token', fetcher);
    await expect(
      sender.send({ telegramUserId: '123456789', title: 'Hello', body: 'World' }),
    ).resolves.toEqual({ providerMessageKey: 'telegram:42' });
    const requestBody = fetcher.mock.calls[0]![1]!.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body.');
    const parsed: unknown = JSON.parse(requestBody);
    expect(parsed).toMatchObject({
      chat_id: '123456789',
      parse_mode: 'HTML',
    });
  });

  it('maps rate limits and terminal recipients to finite safe codes', async () => {
    const limited = new TelegramNotificationSender(
      'secret-token',
      vi
        .fn()
        .mockResolvedValue(
          response({ ok: false, error_code: 429, parameters: { retry_after: 12 } }, 429),
        ),
    );
    await expect(
      limited.send({ telegramUserId: '123456789', title: 'Hello', body: 'World' }),
    ).rejects.toMatchObject({ reasonCode: 'rate_limited', retryAfterMs: 12_000 });

    const blocked = new TelegramNotificationSender(
      'secret-token',
      vi.fn().mockResolvedValue(response({ ok: false, error_code: 403 }, 403)),
    );
    await expect(
      blocked.send({ telegramUserId: '123456789', title: 'Hello', body: 'World' }),
    ).rejects.toMatchObject({ reasonCode: 'bot_blocked' });
  });

  it('quarantines uncertain transport and malformed-success outcomes', async () => {
    const disconnected = new TelegramNotificationSender(
      'secret-token',
      vi.fn().mockRejectedValue(new Error('token-bearing transport detail')),
    );
    await expect(
      disconnected.send({ telegramUserId: '123456789', title: 'Hello', body: 'World' }),
    ).rejects.toMatchObject({ reasonCode: 'ambiguous_result' });

    const malformed = new TelegramNotificationSender(
      'secret-token',
      vi.fn().mockResolvedValue(response({ ok: true, result: {} })),
    );
    await expect(
      malformed.send({ telegramUserId: '123456789', title: 'Hello', body: 'World' }),
    ).rejects.toMatchObject({ reasonCode: 'ambiguous_result' });
  });
});
