import { randomUUID, timingSafeEqual } from 'node:crypto';
export { TelegramMediaTransportCipher } from './media-cipher.js';

import {
  RegisterTelegramIdentityHandler,
  routeStart,
  type IdentityStore,
  type RegisterTelegramIdentityUseCase,
  type RateLimiterPort,
  type StartViewModel,
  type TelegramClientPort,
  type TelegramMediaDownload,
  type TelegramMediaPort,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class TelegramWebhookAuthenticator {
  public constructor(private readonly expectedSecret: string) {}

  public verify(receivedSecret: string | undefined): boolean {
    return receivedSecret !== undefined && safeEqual(receivedSecret, this.expectedSecret);
  }
}

export class UnconfiguredTelegramClient implements TelegramClientPort {
  public sendText(): Promise<void> {
    return Promise.reject(new Error('The production Telegram client is configured in M1.'));
  }
}

type TelegramApiResponse = Readonly<{
  ok: boolean;
  result?: Readonly<{ file_path?: string; file_size?: number }>;
  description?: string;
}>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thin Bot API adapter. The file path is accepted only from Telegram's JSON response;
 * callers cannot provide a URL or host. The response body remains a streaming iterator. */
export class TelegramPhotoDownloadAdapter implements TelegramMediaPort {
  public constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
    private readonly apiOrigin = 'https://api.telegram.org',
  ) {
    if (botToken.trim() === '') throw new Error('Telegram bot token is required.');
    if (apiOrigin !== 'https://api.telegram.org') throw new Error('Telegram API origin is fixed.');
  }

  public async download(fileId: string, signal?: AbortSignal): Promise<TelegramMediaDownload> {
    try {
      const deadline = AbortSignal.timeout(60_000);
      return await this.downloadBounded(
        fileId,
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      );
    } catch {
      // Fetch errors can contain the bot-token-bearing URL; do not retain a cause.
      throw new Error('Telegram file metadata or download unavailable.');
    }
  }

  private async downloadBounded(
    fileId: string,
    signal: AbortSignal,
  ): Promise<TelegramMediaDownload> {
    if (!/^[^\s]{1,512}$/u.test(fileId)) throw new Error('Telegram file id is invalid.');
    const metadataResponse = await this.fetcher(`${this.apiOrigin}/bot${this.botToken}/getFile`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      ...(signal === undefined ? {} : { signal }),
    });
    const metadata = await this.readJson(metadataResponse);
    const filePath = metadata.result?.file_path;
    if (
      !metadata.ok ||
      typeof filePath !== 'string' ||
      filePath.length > 1024 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/u.test(filePath) ||
      filePath.split('/').some((part) => part === '.' || part === '..')
    )
      throw new Error('Telegram file metadata is unavailable.');
    const response = await this.fetcher(`${this.apiOrigin}/file/bot${this.botToken}/${filePath}`, {
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok || response.body === null) throw new Error('Telegram file download failed.');
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength =
      contentLengthHeader === null ? metadata.result?.file_size : Number(contentLengthHeader);
    return {
      body: this.readBody(response.body),
      cancel: async () => {
        if (!response.body!.locked) {
          try {
            await response.body!.cancel();
          } catch {
            /* A failed response is already closed. */
          }
        }
      },
      ...(contentLength === undefined || !Number.isSafeInteger(contentLength)
        ? {}
        : { contentLength }),
      ...(response.headers.get('content-type') === null
        ? {}
        : { contentType: response.headers.get('content-type')! }),
    };
  }

  private async readJson(response: Response): Promise<TelegramApiResponse> {
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error('Telegram API request failed.');
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of this.readBody(response.body)) {
      bytes += chunk.byteLength;
      if (bytes > 65_536) throw new Error('Telegram metadata response too large.');
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('Telegram API response is invalid.');
    return value as TelegramApiResponse;
  }

  private async *readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        if (!(next.value instanceof Uint8Array))
          throw new Error('Telegram response body is invalid.');
        yield next.value;
      }
    } catch {
      throw new Error('Telegram file stream unavailable.');
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* The stream may already have failed. */
      }
      reader.releaseLock();
    }
  }
}

type TelegramStartUpdate = Readonly<{
  updateId: string;
  telegramUserId: string;
  username: string | undefined;
}>;

export type TelegramStartResult =
  | Readonly<{ handled: false }>
  | Readonly<{ handled: true; userId: string; replayed: boolean; view: StartViewModel }>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseStartUpdate(update: unknown): TelegramStartUpdate | undefined {
  const root = record(update);
  const message = record(root?.message);
  const from = record(message?.from);
  const updateId = root?.update_id;
  const userId = from?.id;
  const text = message?.text;
  if (
    !Number.isSafeInteger(updateId) ||
    !Number.isSafeInteger(userId) ||
    typeof text !== 'string' ||
    !/^\/start(?:\s|$)/u.test(text)
  ) {
    return undefined;
  }
  const username = from?.username;
  return {
    updateId: String(updateId),
    telegramUserId: String(userId),
    username: typeof username === 'string' ? username : undefined,
  };
}

export class TelegramStartAdapter {
  public constructor(
    private readonly useCase: RegisterTelegramIdentityUseCase,
    private readonly systemActorId = '00000000-0000-4000-8000-000000000001',
    private readonly uuid: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly rateLimiter?: RateLimiterPort,
  ) {}

  public static withStore(
    store: IdentityStore,
    rateLimiter?: RateLimiterPort,
  ): TelegramStartAdapter {
    const ids = { uuid: randomUUID };
    const clock = { now: (): Date => new Date() };
    return new TelegramStartAdapter(
      new RegisterTelegramIdentityHandler(store, ids, clock),
      '00000000-0000-4000-8000-000000000001',
      randomUUID,
      () => new Date(),
      rateLimiter,
    );
  }

  public async handle(update: unknown): Promise<TelegramStartResult> {
    const parsed = parseStartUpdate(update);
    if (parsed === undefined) return { handled: false };
    const rate = await this.rateLimiter?.consume({
      scope: 'telegram_start',
      subject: parsed.telegramUserId,
      limit: 20,
      windowSeconds: 60,
    });
    if (rate !== undefined && !rate.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429, {
        retryAfterSeconds: String(rate.retryAfterSeconds),
      });
    const result = await this.useCase.execute({
      commandId: this.uuid(),
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { userId: this.systemActorId, kind: 'system' },
      requestId: this.uuid(),
      idempotencyKey: `telegram-update:${parsed.updateId}`,
      occurredAt: this.now().toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: parsed.telegramUserId },
      data: {
        telegramUserId: parsed.telegramUserId,
        updateId: parsed.updateId,
        ...(parsed.username === undefined ? {} : { username: parsed.username }),
      },
    });
    return {
      handled: true,
      userId: result.context.userId,
      replayed: result.replayed,
      view: routeStart(result.context.entryRoute),
    };
  }
}
