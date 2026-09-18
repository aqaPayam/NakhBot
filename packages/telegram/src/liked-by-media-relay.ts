import type { LocalizedIntent } from '@nakh/application';

import {
  type TelegramLockedLikedByCard,
  validLikedByBlurredGrant,
  validateLikedByMediaOrigin,
} from './liked-by-screen.js';
import { TelegramLikedBySendFailure } from './liked-by-send-failure.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramMediaAudienceCredentials {
  /** Mint a short-lived credential that the private edge resolves to this viewer. */
  tokenFor(viewerUserId: string): Promise<string>;
}

const MAX_BLURRED_BYTES = 2 * 1024 * 1024;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TELEGRAM_ID = /^[1-9][0-9]{0,19}$/u;
const OPAQUE_ACTION = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]{16,4096}={0,2}$/u;
const BOT_TOKEN = /^[A-Za-z0-9:_-]+$/u;

function unavailable(): TelegramLikedBySendFailure {
  return new TelegramLikedBySendFailure('media_unavailable');
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  requireOk = true,
): Promise<Uint8Array> {
  if ((requireOk && !response.ok) || !response.body) throw unavailable();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[1-9][0-9]*$/u.test(declared) || Number(declared) > maximumBytes))
    throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value as Uint8Array;
      size += chunk.byteLength;
      if (size > maximumBytes) throw unavailable();
      chunks.push(chunk);
    }
    if (size === 0 || (declared !== null && size !== Number(declared))) throw unavailable();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return bytes;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function retryAfterMs(payload: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const seconds = asRecord(payload?.parameters)?.retry_after;
  return typeof seconds === 'number' &&
    Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    seconds <= 3_600
    ? seconds * 1_000
    : undefined;
}

async function acceptedMessageId(response: Response): Promise<number> {
  let payload: Readonly<Record<string, unknown>> | undefined;
  try {
    const bytes = await readBounded(response, 65_536, false);
    payload = asRecord(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
  } catch {
    // HTTP status remains authoritative when the provider body is missing or malformed.
  }
  const errorCode = payload?.error_code;
  if (response.status === 429 || errorCode === 429)
    throw new TelegramLikedBySendFailure('provider_unavailable', retryAfterMs(payload));
  if (
    (response.status >= 400 && response.status < 500) ||
    (typeof errorCode === 'number' && errorCode >= 400 && errorCode < 500)
  )
    throw new TelegramLikedBySendFailure('provider_rejected');
  if (!response.ok || payload?.ok !== true)
    throw new TelegramLikedBySendFailure('provider_unavailable');
  const messageId = asRecord(payload.result)?.message_id;
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0)
    throw new TelegramLikedBySendFailure('provider_unavailable');
  return messageId;
}

/** Server-side relay: signed CDN grants and audience credentials never enter Bot API requests. */
export class TelegramLockedLikedByMediaRelay {
  private readonly mediaOrigin: string;

  public constructor(
    mediaOrigin: string,
    private readonly botToken: string,
    private readonly audience: TelegramMediaAudienceCredentials,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {
    this.mediaOrigin = validateLikedByMediaOrigin(mediaOrigin);
    if (!BOT_TOKEN.test(botToken)) throw new Error('Telegram bot token is invalid.');
  }

  public async sendCard(
    viewerUserId: string,
    telegramUserId: string,
    card: TelegramLockedLikedByCard,
    render: (intent: LocalizedIntent) => string,
  ): Promise<number> {
    if (
      !USER_ID.test(viewerUserId) ||
      !TELEGRAM_ID.test(telegramUserId) ||
      !OPAQUE_ACTION.test(card.unlock.callbackData) ||
      !validLikedByBlurredGrant(card.blurredPhoto, this.mediaOrigin, this.now())
    )
      throw unavailable();
    const caption = render(card.label);
    const button = render(card.unlock.label);
    if (
      caption.length < 1 ||
      caption.length > 1024 ||
      button.length < 1 ||
      button.length > 64 ||
      Buffer.byteLength(card.unlock.callbackData, 'utf8') > 64
    )
      throw unavailable();
    let bytes: Uint8Array;
    try {
      const credential = await this.audience.tokenFor(viewerUserId);
      if (!BEARER_TOKEN.test(credential)) throw unavailable();
      const media = await this.fetcher(card.blurredPhoto.deliveryUrl, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (media.headers.get('content-type') !== 'image/webp') throw unavailable();
      bytes = await readBounded(media, MAX_BLURRED_BYTES);
    } catch {
      throw unavailable();
    }
    const body = new FormData();
    body.set('chat_id', telegramUserId);
    body.set('caption', caption);
    body.set(
      'reply_markup',
      JSON.stringify({
        inline_keyboard: [[{ text: button, callback_data: card.unlock.callbackData }]],
      }),
    );
    body.set('photo', new Blob([bytes], { type: 'image/webp' }), 'blurred-preview.webp');
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.botToken}/sendPhoto`, {
        method: 'POST',
        redirect: 'error',
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new TelegramLikedBySendFailure(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'provider_timeout'
          : 'provider_unavailable',
      );
    }
    return acceptedMessageId(response);
  }
}
