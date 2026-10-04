import { describe, expect, it, vi } from 'vitest';
import { TelegramAdminTextDelivery } from './admin-text-delivery.js';

const input = {
  recipient: '123',
  text: '<b>literal</b> https://private.invalid 🙂',
  disableLinkPreviews: true as const,
};
describe('protected Telegram admin text delivery', () => {
  it('delivers only opaque bounded queue buttons and returns a protected reason prompt message identity', async () => {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(() =>
        Promise.resolve(new Response('{"ok":true,"result":{"message_id":37}}')),
      );
    const sender = new TelegramAdminTextDelivery('99:private-token', fetcher);
    const extraButton = {
      text: 'Open request',
      callback_data: `m7q:${'a'.repeat(22)}`,
      url: 'https://private.invalid',
    };
    await sender.queueMenu({
      ...input,
      replyMarkup: {
        inline_keyboard: [[extraButton]],
      },
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
      protect_content: true,
      reply_markup: {
        inline_keyboard: [[{ text: 'Open request', callback_data: `m7q:${'a'.repeat(22)}` }]],
      },
    });
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain('"url"');
    await expect(sender.reasonPrompt(input)).resolves.toBe(37);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toMatchObject({
      protect_content: true,
      reply_markup: { force_reply: true, selective: true },
    });
    await expect(
      sender.queueMenu({
        ...input,
        replyMarkup: { inline_keyboard: [[{ text: 'Unsafe', callback_data: 'unban:target' }]] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sends one plain protected message with current preview controls and a timeout', async () => {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response('{"ok":true,"result":{"message_id":12}}'));
    await new TelegramAdminTextDelivery('123:private-token', fetcher).text(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bot123:private-token/sendMessage');
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request!.body as string)).toEqual({
      chat_id: '123',
      text: input.text,
      link_preview_options: { is_disabled: true },
      protect_content: true,
    });
  });
  it.each([
    { recipient: '-123' },
    { recipient: 'https://private.invalid' },
    { text: '' },
    { text: 'x'.repeat(3501) },
    { disableLinkPreviews: false },
  ])(
    'rejects invalid recipient, chunk or preview settings before contacting Telegram: %s',
    async (changed) => {
      const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
      const sender = new TelegramAdminTextDelivery('123:private-token', fetcher);
      await expect(sender.text({ ...input, ...changed } as typeof input)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(
    [
      '{"ok":false,"description":"private provider diagnostics"}',
      '{"ok":true}',
      '{"ok":true,"result":{"message_id":0}}',
      '{"ok":true,"result":{"message_id":"12"}}',
      '{"ok":true,"result":{"message_id":1.5}}',
      'not JSON',
      'x'.repeat(65537),
    ].map((body, index) => ({ body, index })),
  )(
    'sanitizes malformed, oversized or rejected acknowledgement $index without retry',
    async ({ body }) => {
      const fetcher = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValue(new Response(body));
      await expect(
        new TelegramAdminTextDelivery('123:private-token', fetcher).text(input),
      ).rejects.toMatchObject({ code: 'internal_error', message: 'error.m7.internal' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('sanitizes HTTP/network failures and cancels an oversized stream without reading its tail', async () => {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(
        new Error('https://api.telegram.org/bot123:private-token private prose'),
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true,"result":{"message_id":12}}', { status: 403 }),
      );
    const sender = new TelegramAdminTextDelivery('123:private-token', fetcher);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(sender.text(input)).rejects.toMatchObject({ message: 'error.m7.internal' });
    const cancel = vi.fn();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(70000));
      },
      cancel,
    });
    fetcher.mockResolvedValueOnce(new Response(stream));
    await expect(sender.text(input)).rejects.toMatchObject({ message: 'error.m7.internal' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reads).toBeLessThanOrEqual(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
