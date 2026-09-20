import { describe, expect, it, vi } from 'vitest';

import { TelegramLockedLikedByScreenRelay } from './liked-by-screen-relay.js';

const botToken = `123:${'a'.repeat(24)}`;
const cursor = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
const render = (intent: { key: string; variables: Readonly<Record<string, unknown>> }): string =>
  intent.key === 'liked_by.title'
    ? `People who liked you: ${String(intent.variables.count)}`
    : intent.key === 'liked_by.empty'
      ? 'No likes yet'
      : 'Next';

function success(id = 42): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: id } }), { status: 200 });
}

describe('Telegram locked Liked By screen relay', () => {
  it('sends one bounded localized header with an opaque pagination control', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const relay = new TelegramLockedLikedByScreenRelay(
      botToken,
      vi.fn((input: string, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(success());
      }),
    );
    await expect(
      relay.sendScreen({
        botId: '123',
        telegramUserId: '456',
        screen: {
          title: { key: 'liked_by.title', variables: { count: 0 } },
          emptyState: { key: 'liked_by.empty', variables: {} },
          cards: [],
          nextPage: {
            label: { key: 'liked_by.button.next', variables: {} },
            callbackData: cursor,
          },
        },
        render,
      }),
    ).resolves.toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(`https://api.telegram.org/bot${botToken}/sendMessage`);
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      chat_id: '456',
      text: 'People who liked you: 0\nNo likes yet',
      reply_markup: {
        inline_keyboard: [[{ text: 'Next', callback_data: cursor }]],
      },
    });
  });

  it('rejects the wrong bot identity and malformed output before network access', async () => {
    const fetcher = vi.fn(() => Promise.resolve(success()));
    const relay = new TelegramLockedLikedByScreenRelay(botToken, fetcher);
    const base = {
      botId: '999',
      telegramUserId: '456',
      screen: { title: { key: 'liked_by.title', variables: { count: 0 } }, cards: [] },
      render,
    } as const;
    await expect(relay.sendScreen(base)).rejects.toMatchObject({
      reasonCode: 'provider_rejected',
    });
    await expect(
      relay.sendScreen({ ...base, botId: '123', render: () => 'x'.repeat(4_097) }),
    ).rejects.toMatchObject({ reasonCode: 'provider_rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honors bounded retry-after while discarding provider response details', async () => {
    const relay = new TelegramLockedLikedByScreenRelay(botToken, () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: 'sensitive provider body',
            parameters: { retry_after: 13 },
          }),
          { status: 429 },
        ),
      ),
    );
    let failure: Error & { reasonCode?: string; retryAfterMs?: number } = new Error('missing');
    try {
      await relay.sendScreen({
        botId: '123',
        telegramUserId: '456',
        screen: { title: { key: 'liked_by.title', variables: { count: 1 } }, cards: [] },
        render,
      });
    } catch (error) {
      failure = error as Error & { reasonCode?: string; retryAfterMs?: number };
    }
    expect(failure).toMatchObject({ reasonCode: 'provider_unavailable', retryAfterMs: 13_000 });
    expect(failure.message).not.toContain('sensitive provider body');
  });

  it('classifies terminal recipients, outages, and transport timeouts', async () => {
    const request = {
      botId: '123',
      telegramUserId: '456',
      screen: { title: { key: 'liked_by.title', variables: { count: 1 } }, cards: [] },
      render,
    } as const;
    for (const [response, reasonCode] of [
      [new Response('{"ok":false}', { status: 403 }), 'provider_rejected'],
      [new Response('{"ok":false}', { status: 503 }), 'provider_unavailable'],
    ] as const) {
      await expect(
        new TelegramLockedLikedByScreenRelay(botToken, () => Promise.resolve(response)).sendScreen(
          request,
        ),
      ).rejects.toMatchObject({ reasonCode });
    }
    await expect(
      new TelegramLockedLikedByScreenRelay(botToken, () =>
        Promise.reject(new DOMException('timed out', 'TimeoutError')),
      ).sendScreen(request),
    ).rejects.toMatchObject({ reasonCode: 'provider_timeout' });
  });

  it('requires a token whose prefix is the configured numeric bot identity', () => {
    expect(() => new TelegramLockedLikedByScreenRelay('bot-secret')).toThrow(
      'Telegram bot token is invalid.',
    );
  });
});
