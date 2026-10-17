import { describe, expect, it, vi } from 'vitest';
import {
  TelegramCandidateMediaRelay,
  type TelegramCandidateCard,
} from './candidate-media-relay.js';

const botToken = '12345:' + 'b'.repeat(32),
  audienceSecret = 'private-audience-credential';
const base: TelegramCandidateCard = {
  viewerUserId: '10000000-0000-4000-8000-000000000001',
  telegramUserId: '789',
  photo: {
    variantType: 'thumbnail',
    cachePolicy: 'no-store',
    expiresAt: '2026-10-17T00:01:00.000Z',
    deliveryUrl:
      'https://media.example.test/media/20000000-0000-4000-8000-000000000001/thumbnail-v1.webp?token=payload.signature',
  },
  caption: 'Synthetic profile, approximately 30\nCity\nHighlight',
  keyboard: [
    [{ text: 'Next profile', callback_data: 'm9s:' + 'a'.repeat(16) + ':' + 'b'.repeat(22) }],
  ],
};
const now = Date.parse('2026-10-17T00:00:00.000Z');
const webp = (): Response =>
  new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'image/webp' } });
function accepted(chatId = 789): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      result: {
        message_id: 42,
        chat: { id: chatId, type: 'private' },
        from: { id: 12345, is_bot: true },
      },
    }),
  );
}
describe('private candidate photo relay', () => {
  it('fetches private bytes before the native start, then sends no edge URL or credential to Telegram', async () => {
    const order: string[] = [],
      calls: RequestInit[] = [];
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      calls.push(init!);
      order.push(url.startsWith('https://media.') ? 'media' : 'provider');
      return Promise.resolve(calls.length === 1 ? webp() : accepted());
    });
    const relay = new TelegramCandidateMediaRelay(
      'https://media.example.test',
      botToken,
      { tokenFor: () => Promise.resolve(audienceSecret) },
      fetcher,
      () => now,
    );
    expect(
      await relay.send(base, () => {
        order.push('native-start');
        return Promise.resolve(true);
      }),
    ).toBe('42');
    expect(order).toEqual(['media', 'native-start', 'provider']);
    expect(calls[0]!.headers).toEqual({ authorization: 'Bearer ' + audienceSecret });
    const body = calls[1]!.body as FormData;
    expect(body.get('chat_id')).toBe('789');
    expect(body.get('caption')).toBe(base.caption);
    expect([...body.keys()]).toEqual(['chat_id', 'caption', 'reply_markup', 'photo']);
    const bytes = body.get('photo') as Blob;
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([82, 73, 70, 70]);
    expect(JSON.stringify([...body.entries()])).not.toContain('payload.signature');
    expect(JSON.stringify(calls[1])).not.toContain(audienceSecret);
  });
  it('never calls Telegram when the native start loses a race', async () => {
    const fetcher = vi.fn(() => Promise.resolve(webp()));
    const relay = new TelegramCandidateMediaRelay(
      'https://media.example.test',
      botToken,
      { tokenFor: () => Promise.resolve(audienceSecret) },
      fetcher,
      () => now,
    );
    await expect(relay.send(base, () => Promise.resolve(false))).rejects.toMatchObject({
      code: 'not_started',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['expiry', 'foreign-origin', 'original', 'callback'] as const)(
    'rejects %s before provider admission',
    async (mode) => {
      const card = structuredClone(base),
        fetcher = vi.fn(() => Promise.resolve(webp())),
        start = vi.fn(() => Promise.resolve(true));
      const changed =
        mode === 'expiry'
          ? { ...card, photo: { ...card.photo, expiresAt: new Date(now).toISOString() } }
          : mode === 'foreign-origin'
            ? {
                ...card,
                photo: {
                  ...card.photo,
                  deliveryUrl: card.photo.deliveryUrl.replace(
                    'media.example.test',
                    'other.example.test',
                  ),
                },
              }
            : mode === 'original'
              ? {
                  ...card,
                  photo: {
                    ...card.photo,
                    deliveryUrl: card.photo.deliveryUrl.replace('thumbnail-v1.webp', 'original'),
                  },
                }
              : { ...card, keyboard: [[{ text: 'Next', callback_data: 'borrowed-action' }]] };
      const relay = new TelegramCandidateMediaRelay(
        'https://media.example.test',
        botToken,
        { tokenFor: () => Promise.resolve(audienceSecret) },
        fetcher,
        () => now,
      );
      await expect(relay.send(changed, start)).rejects.toMatchObject({ code: 'media_unavailable' });
      expect(start).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('cancels an oversized stream without starting a provider call', async () => {
    const cancel = vi.fn(),
      start = vi.fn(() => Promise.resolve(true));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { 'content-type': 'image/webp' } },
    );
    const relay = new TelegramCandidateMediaRelay(
      'https://media.example.test',
      botToken,
      { tokenFor: () => Promise.resolve(audienceSecret) },
      () => Promise.resolve(response),
      () => now,
    );
    await expect(relay.send(base, start)).rejects.toMatchObject({ code: 'media_unavailable' });
    expect(cancel).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it.each(['rejected', 'wrong-recipient', 'network', 'malformed'] as const)(
    'distinguishes %s after native call-start',
    async (mode) => {
      let count = 0;
      const fetcher = vi.fn(() => {
        if (++count === 1) return Promise.resolve(webp());
        if (mode === 'network') return Promise.reject(new Error(botToken + audienceSecret));
        return Promise.resolve(
          mode === 'rejected'
            ? new Response('{"ok":false,"error_code":403}', { status: 403 })
            : mode === 'wrong-recipient'
              ? accepted(999)
              : new Response('invalid ' + audienceSecret),
        );
      });
      const relay = new TelegramCandidateMediaRelay(
        'https://media.example.test',
        botToken,
        { tokenFor: () => Promise.resolve(audienceSecret) },
        fetcher,
        () => now,
      );
      const result = relay.send(base, () => Promise.resolve(true));
      await expect(result).rejects.toMatchObject({
        code: mode === 'rejected' ? 'provider_rejected' : 'provider_ambiguous',
      });
      await expect(result).rejects.toThrow('Telegram candidate delivery unavailable.');
    },
  );
});
