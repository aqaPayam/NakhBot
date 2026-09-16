import { describe, expect, it, vi } from 'vitest';
import { TelegramBotApiMenuClient, renderTelegramPhotoMenu } from './photo-menu-delivery.js';

describe('Telegram photo-menu delivery', () => {
  it('renders localized text and an inline keyboard without parse-mode injection', () => {
    const rendered = renderTelegramPhotoMenu(
      {
        title: { key: 'title', variables: { count: 1 } },
        rows: [
          {
            label: { key: 'photo', variables: { position: 1 } },
            buttons: [
              {
                kind: 'delete',
                label: { key: 'delete', variables: {} },
                callbackData: 'v1.pm.abcdefghijklmnop.83u2A2bTH5JUrFIB',
              },
            ],
          },
        ],
      },
      (intent) => ({ title: '<Your photos>', photo: 'Photo 1', delete: 'Delete' })[intent.key]!,
    );
    expect(rendered).toEqual({
      text: '<Your photos>\nPhoto 1',
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: 'Delete',
              callback_data: 'v1.pm.abcdefghijklmnop.83u2A2bTH5JUrFIB',
            },
          ],
        ],
      },
    });
  });

  it('posts fixed Bot API methods and hides the token from provider failures', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn((input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });
    const client = new TelegramBotApiMenuClient('secret-token', fetcher);
    await client.sendMenu('123', { text: 'menu', replyMarkup: { inline_keyboard: [] } });
    await client.answerCallback('callback-1');
    expect(calls.map((call) => call.input)).toEqual([
      'https://api.telegram.org/botsecret-token/sendMessage',
      'https://api.telegram.org/botsecret-token/answerCallbackQuery',
    ]);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      chat_id: '123',
      text: 'menu',
      reply_markup: { inline_keyboard: [] },
    });
    const failed = new TelegramBotApiMenuClient('do-not-leak', () =>
      Promise.reject(new Error('x')),
    );
    await expect(
      failed.sendMenu('123', {
        text: 'menu',
        replyMarkup: { inline_keyboard: [] },
      }),
    ).rejects.toThrow('Telegram menu delivery unavailable.');
  });
});
