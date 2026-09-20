import type { LocalizedIntent } from '@nakh/application';
import type { TelegramPhotoMenu } from './photo-menu.js';

export type RenderedTelegramPhotoMenu = Readonly<{
  text: string;
  replyMarkup: Readonly<{
    inline_keyboard: ReadonlyArray<
      ReadonlyArray<Readonly<{ text: string; callback_data: string }>>
    >;
  }>;
}>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function renderTelegramPhotoMenu(
  menu: TelegramPhotoMenu,
  render: (intent: LocalizedIntent) => string,
): RenderedTelegramPhotoMenu {
  const lines = [render(menu.title)];
  if (menu.emptyState !== undefined) lines.push(render(menu.emptyState));
  lines.push(...menu.rows.map((row) => render(row.label)));
  const text = lines.join('\n');
  if (text.length < 1 || text.length > 4096)
    throw new Error('Telegram photo-menu text is invalid.');
  const inlineKeyboard = menu.rows
    .map((row) =>
      row.buttons.map((button) => {
        const label = render(button.label);
        if (label.length < 1 || label.length > 64)
          throw new Error('Telegram photo-menu button label is invalid.');
        if (Buffer.byteLength(button.callbackData, 'utf8') > 64)
          throw new Error('Telegram photo-menu callback is invalid.');
        return { text: label, callback_data: button.callbackData };
      }),
    )
    .filter((row) => row.length > 0);
  return { text, replyMarkup: { inline_keyboard: inlineKeyboard } };
}

export class TelegramBotApiMenuClient {
  public constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
    private readonly apiOrigin = 'https://api.telegram.org',
  ) {
    if (botToken.trim() === '') throw new Error('Telegram bot token is required.');
    if (apiOrigin !== 'https://api.telegram.org') throw new Error('Telegram API origin is fixed.');
  }

  public async sendMenu(telegramUserId: string, menu: RenderedTelegramPhotoMenu): Promise<void> {
    if (!/^[1-9][0-9]{0,19}$/u.test(telegramUserId))
      throw new Error('Telegram menu recipient is invalid.');
    await this.call('sendMessage', {
      chat_id: telegramUserId,
      text: menu.text,
      reply_markup: menu.replyMarkup,
    });
  }

  public async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (
      callbackQueryId.length < 1 ||
      callbackQueryId.length > 128 ||
      (text !== undefined && (text.length < 1 || text.length > 200))
    )
      throw new Error('Telegram callback query is invalid.');
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
    });
  }

  private async call(method: 'answerCallbackQuery' | 'sendMessage', body: unknown): Promise<void> {
    try {
      const response = await this.fetcher(`${this.apiOrigin}/bot${this.botToken}/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || bytes.byteLength > 65_536) throw new Error('request failed');
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        (parsed as Readonly<Record<string, unknown>>).ok !== true
      )
        throw new Error('request failed');
    } catch {
      throw new Error('Telegram menu delivery unavailable.');
    }
  }
}
