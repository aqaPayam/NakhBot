import type { LocalizedIntent } from '@nakh/application';

import type { TelegramLockedLikedByScreen } from './liked-by-screen.js';
import { TelegramLikedBySendFailure } from './liked-by-send-failure.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Render = (intent: LocalizedIntent) => string;

const BOT_TOKEN = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u;
const TELEGRAM_ID = /^[1-9][0-9]{0,19}$/u;
const CALLBACK = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function retryDelay(payload: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const seconds = asRecord(payload?.parameters)?.retry_after;
  return typeof seconds === 'number' &&
    Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    seconds <= 3_600
    ? seconds * 1_000
    : undefined;
}

async function messageId(response: Response): Promise<number> {
  let payload: Readonly<Record<string, unknown>> | undefined;
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > 65_536))
      throw new Error('invalid provider response');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 65_536)
      throw new Error('invalid provider response');
    payload = asRecord(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
  } catch {
    // Only bounded status/classification is retained; malformed provider details are discarded.
  }
  const errorCode = payload?.error_code;
  if (response.status === 429 || errorCode === 429)
    throw new TelegramLikedBySendFailure('provider_unavailable', retryDelay(payload));
  if (
    (response.status >= 400 && response.status < 500) ||
    (typeof errorCode === 'number' && errorCode >= 400 && errorCode < 500)
  )
    throw new TelegramLikedBySendFailure('provider_rejected');
  if (!response.ok || payload?.ok !== true)
    throw new TelegramLikedBySendFailure('provider_unavailable');
  const id = asRecord(payload.result)?.message_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw new TelegramLikedBySendFailure('provider_unavailable');
  return id;
}

/** Sends the page header, empty state, and pagination control as one receipt-bearing message. */
export class TelegramLockedLikedByScreenRelay {
  private readonly botId: string;

  public constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
  ) {
    const match = BOT_TOKEN.exec(botToken);
    if (match === null) throw new Error('Telegram bot token is invalid.');
    this.botId = match[1]!;
  }

  public async sendScreen(
    input: Readonly<{
      botId: string;
      telegramUserId: string;
      screen: TelegramLockedLikedByScreen;
      render: Render;
    }>,
  ): Promise<number> {
    if (input.botId !== this.botId || !TELEGRAM_ID.test(input.telegramUserId))
      throw new TelegramLikedBySendFailure('provider_rejected');
    const lines = [input.render(input.screen.title)];
    if (input.screen.emptyState !== undefined) lines.push(input.render(input.screen.emptyState));
    const text = lines.join('\n');
    if (text.length < 1 || text.length > 4_096)
      throw new TelegramLikedBySendFailure('provider_rejected');
    let replyMarkup: Readonly<Record<string, unknown>> | undefined;
    if (input.screen.nextPage !== undefined) {
      const label = input.render(input.screen.nextPage.label);
      const callbackData = input.screen.nextPage.callbackData;
      if (
        label.length < 1 ||
        label.length > 64 ||
        !CALLBACK.test(callbackData) ||
        Buffer.byteLength(callbackData, 'utf8') > 64
      )
        throw new TelegramLikedBySendFailure('provider_rejected');
      replyMarkup = { inline_keyboard: [[{ text: label, callback_data: callbackData }]] };
    }
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: input.telegramUserId,
          text,
          ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new TelegramLikedBySendFailure(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'provider_timeout'
          : 'provider_unavailable',
      );
    }
    return messageId(response);
  }
}
