import { describe, expect, it, vi } from 'vitest';

import { TelegramLockedLikedByMediaRelay } from './liked-by-media-relay.js';
import { TelegramLockedLikedByPresenter } from './liked-by-screen.js';

const viewer = '10000000-0000-4000-8000-000000000000';
const grant = {
  deliveryUrl:
    'https://media.example.test/media/40000000-0000-4000-8000-000000000000/blurred-preview-v1.webp?token=payload.signature',
  expiresAt: '2026-10-01T00:00:00.000Z',
  variantType: 'blurred_preview' as const,
  cachePolicy: 'no-store' as const,
};
const card = new TelegramLockedLikedByPresenter('https://media.example.test', () => 1_000).present({
  totalCount: 1,
  cards: [{ actionToken: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba', blurredPhoto: grant }],
}).cards[0]!;
const render = (intent: { key: string }): string =>
  ({ 'liked_by.card.locked': 'Like 1 · Locked', 'liked_by.button.unlock': 'Unlock' })[intent.key]!;
const audience = { tokenFor: vi.fn(() => Promise.resolve('viewer-bound-secret-token')) };

function webp(bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46])): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/webp', 'content-length': String(bytes.byteLength) },
  });
}

describe('Telegram locked Liked By media relay', () => {
  it('fetches with viewer credentials, then uploads only bounded bytes to Telegram', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn((input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(
        calls.length === 1
          ? webp()
          : new Response('{"ok":true,"result":{"message_id":42}}', { status: 200 }),
      );
    });
    const relay = new TelegramLockedLikedByMediaRelay(
      'https://media.example.test',
      'bot-secret',
      audience,
      fetcher,
      () => 1_000,
    );
    await expect(relay.sendCard(viewer, '12345', card, render)).resolves.toBe(42);
    expect(audience.tokenFor).toHaveBeenCalledWith(viewer);
    expect(calls.map((call) => call.input)).toEqual([
      grant.deliveryUrl,
      'https://api.telegram.org/botbot-secret/sendPhoto',
    ]);
    expect(calls[0]!.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { authorization: 'Bearer viewer-bound-secret-token' },
    });
    const telegram = calls[1]!.init!;
    expect(telegram.headers).toBeUndefined();
    expect(telegram.body).toBeInstanceOf(FormData);
    const body = telegram.body as FormData;
    expect(body.get('chat_id')).toBe('12345');
    expect(body.get('caption')).toBe('Like 1 · Locked');
    expect(JSON.parse(body.get('reply_markup') as string)).toEqual({
      inline_keyboard: [[{ text: 'Unlock', callback_data: card.unlock.callbackData }]],
    });
    const uploaded = body.get('photo') as Blob;
    expect(uploaded.type).toBe('image/webp');
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    );
    expect(JSON.stringify([...body.entries()])).not.toContain('payload.signature');
    expect(JSON.stringify([...body.entries()])).not.toContain('viewer-bound-secret-token');
  });

  it('rejects expired, foreign, and malformed grants before credential minting', async () => {
    const credentials = { tokenFor: vi.fn(() => Promise.resolve('viewer-bound-secret-token')) };
    const fetcher = vi.fn(() => Promise.resolve(webp()));
    const relay = new TelegramLockedLikedByMediaRelay(
      'https://media.example.test',
      'bot-secret',
      credentials,
      fetcher,
      () => 1_000,
    );
    for (const deliveryUrl of [
      grant.deliveryUrl.replace('media.example.test', 'evil.example.test'),
      grant.deliveryUrl.replace('blurred-preview-v1', 'thumbnail-v1'),
      grant.deliveryUrl.replace('https:', 'http:'),
    ]) {
      await expect(
        relay.sendCard(
          viewer,
          '12345',
          { ...card, blurredPhoto: { ...grant, deliveryUrl } },
          render,
        ),
      ).rejects.toThrow('delivery unavailable');
    }
    await expect(
      relay.sendCard(
        viewer,
        '12345',
        { ...card, blurredPhoto: { ...grant, expiresAt: '1970-01-01T00:00:00.000Z' } },
        render,
      ),
    ).rejects.toThrow('delivery unavailable');
    expect(credentials.tokenFor).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsafe Bot API tokens and unauthenticated media requests', async () => {
    expect(
      () =>
        new TelegramLockedLikedByMediaRelay('https://media.example.test', 'bot/../token', audience),
    ).toThrow('Telegram bot token is invalid.');
    const fetcher = vi.fn(() => Promise.resolve(webp()));
    const relay = new TelegramLockedLikedByMediaRelay(
      'https://media.example.test',
      'bot-secret',
      { tokenFor: () => Promise.resolve('') },
      fetcher,
      () => 1_000,
    );
    await expect(relay.sendCard(viewer, '12345', card, render)).rejects.toThrow(
      'Telegram locked-card delivery unavailable.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed on wrong media type, oversized stream, or invalid provider reply', async () => {
    const failures = [
      () => new Response('not an image', { headers: { 'content-type': 'text/plain' } }),
      () =>
        new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'image/webp' },
        }),
      () => webp(),
    ];
    for (const [index, media] of failures.entries()) {
      const fetcher = vi.fn((input: string) =>
        Promise.resolve(
          input.startsWith('https://media.example.test')
            ? media()
            : new Response('{"ok":false}', { status: 200 }),
        ),
      );
      const relay = new TelegramLockedLikedByMediaRelay(
        'https://media.example.test',
        'bot-secret',
        audience,
        fetcher,
        () => 1_000,
      );
      await expect(relay.sendCard(viewer, '12345', card, render)).rejects.toThrow(
        'Telegram locked-card delivery unavailable.',
      );
      expect(fetcher).toHaveBeenCalledTimes(index === 2 ? 2 : 1);
    }
  });
});
