import { describe, expect, it, vi } from 'vitest';
import { TelegramAdminTextDelivery } from './admin-text-delivery.js';

const input = {
  recipient: '123',
  text: '<b>literal</b> https://private.invalid 🙂',
  disableLinkPreviews: true as const,
};
describe('protected Telegram admin text delivery', () => {
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
