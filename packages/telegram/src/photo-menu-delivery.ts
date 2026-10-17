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

export type TelegramMenuButton =
  | Readonly<{ text: string; callback_data: string; url?: never }>
  | Readonly<{ text: string; url: string; callback_data?: never }>;
export type RenderedTelegramMenu = Readonly<{
  text: string;
  replyMarkup: Readonly<{ inline_keyboard: ReadonlyArray<ReadonlyArray<TelegramMenuButton>> }>;
}>;

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

  public async sendMenu(telegramUserId: string, menu: RenderedTelegramMenu): Promise<void> {
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

  /** The returned private bot message binds free text to its exact prompt. */
  public async sendPrompt(telegramUserId: string, text: string): Promise<number> {
    try {
      const botId = this.botToken.split(':')[0];
      if (
        !/^[1-9][0-9]{0,19}$/u.test(telegramUserId) ||
        !/^[1-9][0-9]*$/u.test(botId ?? '') ||
        text.length < 1 ||
        text.length > 4096
      )
        throw new Error('invalid prompt');
      const result = await this.call('sendMessage', {
        chat_id: telegramUserId,
        text,
        reply_markup: { force_reply: true, selective: true },
      });
      const row =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
      const chat = row.chat as Record<string, unknown> | undefined,
        from = row.from as Record<string, unknown> | undefined;
      if (
        !Number.isSafeInteger(row.message_id) ||
        Number(row.message_id) <= 0 ||
        chat?.type !== 'private' ||
        typeof chat.id !== 'number' ||
        !Number.isSafeInteger(chat.id) ||
        String(chat.id) !== telegramUserId ||
        from?.is_bot !== true ||
        typeof from.id !== 'number' ||
        !Number.isSafeInteger(from.id) ||
        String(from.id) !== botId
      )
        throw new Error('invalid prompt receipt');
      return row.message_id as number;
    } catch {
      throw new Error('Telegram menu delivery unavailable.');
    }
  }

  private async call(
    method: 'answerCallbackQuery' | 'sendMessage',
    body: unknown,
  ): Promise<unknown> {
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
      return (parsed as Readonly<Record<string, unknown>>).result;
    } catch {
      throw new Error('Telegram menu delivery unavailable.');
    }
  }
}
