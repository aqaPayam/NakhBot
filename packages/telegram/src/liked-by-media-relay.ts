import type { LocalizedIntent } from '@nakh/application';

import {
  type TelegramLockedLikedByCard,
  validLikedByBlurredGrant,
  validateLikedByMediaOrigin,
} from './liked-by-screen.js';

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

function unavailable(): Error {
  return new Error('Telegram locked-card delivery unavailable.');
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw unavailable();
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
      const bytes = await readBounded(media, MAX_BLURRED_BYTES);
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
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/sendPhoto`,
        {
          method: 'POST',
          redirect: 'error',
          body,
          signal: AbortSignal.timeout(20_000),
        },
      );
      const resultBytes = await readBounded(response, 65_536);
      const payload: unknown = JSON.parse(Buffer.from(resultBytes).toString('utf8'));
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        (payload as { ok?: unknown }).ok !== true
      )
        throw unavailable();
      const messageId = (payload as { result?: { message_id?: unknown } }).result?.message_id;
      if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0)
        throw unavailable();
      return messageId;
    } catch {
      throw unavailable();
    }
  }
}
