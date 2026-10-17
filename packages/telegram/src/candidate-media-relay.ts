import type { ResolveMediaDeliveryGrantHandler } from '@nakh/application';
import type { TelegramMediaAudienceCredentials } from './liked-by-media-relay.js';
import { validateLikedByMediaOrigin } from './liked-by-screen.js';

export class TelegramCandidateSendFailure extends Error {
  public constructor(
    public readonly code:
      'media_unavailable' | 'not_started' | 'provider_rejected' | 'provider_ambiguous',
  ) {
    super('Telegram candidate delivery unavailable.');
  }
}
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type MediaDeliveryGrant = Awaited<ReturnType<ResolveMediaDeliveryGrantHandler['execute']>>;
type Keyboard = readonly (readonly Readonly<{ text: string; callback_data: string }>[])[];
export type TelegramCandidateCard = Readonly<{
  viewerUserId: string;
  telegramUserId: string;
  photo: MediaDeliveryGrant;
  caption: string;
  keyboard: Keyboard;
}>;
function row(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (response.body === null) throw new Error('empty');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[1-9][0-9]*$/u.test(declared) || Number(declared) > maximum))
    throw new Error('oversize');
  const reader = response.body.getReader();
  let size = 0,
    complete = false;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error('invalid chunk');
      size += chunk.byteLength;
      if (size > maximum) throw new Error('oversize');
      chunks.push(chunk);
    }
    if (size === 0 || (declared !== null && Number(declared) !== size)) throw new Error('size');
    complete = true;
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** Private bytes cross the provider boundary only after the native call-start CAS.
 * Signed media URLs and audience credentials never enter the Bot API request. */
export class TelegramCandidateMediaRelay {
  private readonly origin: string;
  private readonly botId: string;
  public constructor(
    origin: string,
    private readonly botToken: string,
    private readonly audience: TelegramMediaAudienceCredentials,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {
    this.origin = validateLikedByMediaOrigin(origin);
    const match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(botToken);
    if (match === null || !Number.isSafeInteger(Number(match[1])))
      throw new Error('Candidate credentials unavailable.');
    this.botId = match[1]!;
  }
  public async send(
    input: TelegramCandidateCard,
    beforeSend: () => Promise<boolean>,
  ): Promise<string> {
    const card = structuredClone(input);
    let url: URL, bytes: Uint8Array;
    try {
      url = new URL(card.photo.deliveryUrl);
      const expires = new Date(card.photo.expiresAt);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          card.viewerUserId,
        ) ||
        !/^[1-9][0-9]{0,19}$/u.test(card.telegramUserId) ||
        card.photo.variantType !== 'thumbnail' ||
        card.photo.cachePolicy !== 'no-store' ||
        card.photo.deliveryUrl.length > 2048 ||
        !Number.isFinite(expires.getTime()) ||
        expires.toISOString() !== card.photo.expiresAt ||
        expires.getTime() <= this.now() ||
        url.origin !== this.origin ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== '' ||
        !/^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/thumbnail-v1\.webp$/iu.test(
          url.pathname,
        ) ||
        url.searchParams.size !== 1 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(url.searchParams.get('token') ?? '') ||
        card.caption.length < 1 ||
        card.caption.length > 1024 ||
        card.keyboard.length < 1 ||
        card.keyboard.length > 5 ||
        card.keyboard.some(
          (buttons) =>
            buttons.length < 1 ||
            buttons.length > 3 ||
            buttons.some(
              (button) =>
                button.text.length < 1 ||
                button.text.length > 64 ||
                !/^m9s:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$/u.test(button.callback_data),
            ),
        )
      )
        throw new Error('invalid card');
      const credential = await this.audience.tokenFor(card.viewerUserId);
      if (!/^[A-Za-z0-9._~+/-]{16,4096}={0,2}$/u.test(credential))
        throw new Error('invalid audience');
      const response = await this.fetcher(url.href, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok || response.headers.get('content-type') !== 'image/webp')
        throw new Error('invalid media');
      bytes = await bounded(response, 2 * 1024 * 1024);
      if (expires.getTime() <= this.now()) throw new Error('expired media');
    } catch {
      throw new TelegramCandidateSendFailure('media_unavailable');
    }
    let started: boolean;
    try {
      started = await beforeSend();
    } catch {
      throw new TelegramCandidateSendFailure('not_started');
    }
    if (!started) throw new TelegramCandidateSendFailure('not_started');
    try {
      const body = new FormData();
      body.set('chat_id', card.telegramUserId);
      body.set('caption', card.caption);
      body.set('reply_markup', JSON.stringify({ inline_keyboard: card.keyboard }));
      body.set('photo', new Blob([bytes], { type: 'image/webp' }), 'candidate.webp');
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/sendPhoto`,
        {
          method: 'POST',
          redirect: 'error',
          body,
          signal: AbortSignal.timeout(20000),
        },
      );
      const payload = row(
        JSON.parse(Buffer.from(await bounded(response, 65536)).toString('utf8')) as unknown,
      );
      if (
        payload?.ok === false &&
        typeof payload.error_code === 'number' &&
        Number.isInteger(payload.error_code) &&
        payload.error_code >= 400 &&
        payload.error_code < 500 &&
        (response.ok || (response.status >= 400 && response.status < 500))
      )
        throw new TelegramCandidateSendFailure('provider_rejected');
      const message = row(payload?.result),
        chat = row(message?.chat),
        from = row(message?.from);
      if (
        !response.ok ||
        payload?.ok !== true ||
        !Number.isSafeInteger(message?.message_id) ||
        Number(message?.message_id) < 1 ||
        chat?.type !== 'private' ||
        !Number.isSafeInteger(chat.id) ||
        String(chat.id) !== card.telegramUserId ||
        from?.is_bot !== true ||
        !Number.isSafeInteger(from.id) ||
        String(from.id) !== this.botId
      )
        throw new Error('invalid receipt');
      return String(message!.message_id);
    } catch (error) {
      if (error instanceof TelegramCandidateSendFailure) throw error;
      throw new TelegramCandidateSendFailure('provider_ambiguous');
    }
  }
}
