import { randomUUID, timingSafeEqual } from 'node:crypto';
export { TelegramMediaTransportCipher } from './media-cipher.js';
export {
  TelegramLikedByAdapter,
  type TelegramLikedByPageRequest,
  type TelegramLikedByReferences,
  type TelegramLikedByResult,
} from './liked-by-adapter.js';
export { TelegramLikedByPageProcessor } from './liked-by-page-processor.js';
export {
  TelegramLockedLikedByPresenter,
  type TelegramLockedLikedByCard,
  type TelegramLockedLikedByScreen,
} from './liked-by-screen.js';
export {
  TelegramLockedLikedByMediaRelay,
  type TelegramMediaAudienceCredentials,
} from './liked-by-media-relay.js';
export {
  TelegramLikedBySendFailure,
  type TelegramLikedByProviderFailureCode,
} from './liked-by-send-failure.js';
export { TelegramLockedLikedByScreenRelay } from './liked-by-screen-relay.js';
export { TelegramPhotoActionTokens, type TelegramPhotoActionTokenState } from './action-token.js';
export {
  TelegramPhotoMenuPresenter,
  type TelegramPhotoMenu,
  type TelegramPhotoMenuButton,
  type TelegramPhotoMenuRow,
} from './photo-menu.js';
export {
  TelegramBotApiMenuClient,
  renderTelegramPhotoMenu,
  type RenderedTelegramPhotoMenu,
} from './photo-menu-delivery.js';

import {
  type BeginTelegramPhotoIngestionHandler,
  type ListOwnPhotosHandler,
  type MutateOwnPhotosHandler,
  type OwnPhotoAction,
  type OwnPhotoCollection,
  RegisterTelegramIdentityHandler,
  routeStart,
  type IdentityStore,
  type RegisterTelegramIdentityUseCase,
  type RateLimiterPort,
  type StartViewModel,
  type TelegramClientPort,
  type TelegramMediaDownload,
  type TelegramMediaPort,
  type TelegramUserResolver,
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

type TelegramPhotoIngestionUseCase = Pick<BeginTelegramPhotoIngestionHandler, 'execute'>;

export type TelegramPhotoIngestionResult =
  | Readonly<{ handled: false }>
  | Readonly<{
      handled: true;
      result: Awaited<ReturnType<TelegramPhotoIngestionUseCase['execute']>>;
    }>;

type TelegramPhotoUpdate = Readonly<{
  updateId: string;
  telegramUserId: string;
  fileId: string;
  fileUniqueId: string;
  fileSize: number | undefined;
}>;

function parsePhotoUpdate(update: unknown): TelegramPhotoUpdate | undefined {
  const root = record(update);
  const message = record(root?.message);
  const from = record(message?.from);
  const photos = message?.photo;
  const updateId = root?.update_id;
  const telegramUserId = from?.id;
  if (!Array.isArray(photos)) return undefined;
  if (
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    typeof telegramUserId !== 'number' ||
    !Number.isSafeInteger(telegramUserId) ||
    telegramUserId <= 0 ||
    photos.length < 1 ||
    photos.length > 20
  )
    throw new ApplicationError('invalid_request', 'error.media.telegram_photo_invalid', 400);
  const parsed = photos.map((value) => {
    const photo = record(value);
    const width = photo?.width;
    const height = photo?.height;
    const fileSize = photo?.file_size;
    if (
      typeof photo?.file_id !== 'string' ||
      photo.file_id.length < 1 ||
      photo.file_id.length > 512 ||
      /\s/u.test(photo.file_id) ||
      typeof photo.file_unique_id !== 'string' ||
      photo.file_unique_id.length < 1 ||
      photo.file_unique_id.length > 256 ||
      typeof width !== 'number' ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      typeof height !== 'number' ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      (fileSize !== undefined &&
        (typeof fileSize !== 'number' || !Number.isSafeInteger(fileSize) || fileSize < 1))
    )
      throw new ApplicationError('invalid_request', 'error.media.telegram_photo_invalid', 400);
    return {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      width,
      height,
      fileSize,
    };
  });
  const selected = parsed.reduce((largest, candidate) =>
    BigInt(candidate.width) * BigInt(candidate.height) >
    BigInt(largest.width) * BigInt(largest.height)
      ? candidate
      : largest,
  );
  return {
    updateId: String(updateId),
    telegramUserId: String(telegramUserId),
    fileId: selected.fileId,
    fileUniqueId: selected.fileUniqueId,
    fileSize: selected.fileSize,
  };
}

export class TelegramPhotoIngestionAdapter {
  public constructor(
    private readonly resolver: TelegramUserResolver,
    private readonly useCase: TelegramPhotoIngestionUseCase,
    private readonly uuid: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async handle(update: unknown): Promise<TelegramPhotoIngestionResult> {
    const photo = parsePhotoUpdate(update);
    if (photo === undefined) return { handled: false };
    const userId = await this.resolver.resolveUserId(photo.telegramUserId);
    if (userId === undefined)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const result = await this.useCase.execute({
      commandId: this.uuid(),
      commandType: 'media.begin-telegram-photo-ingestion',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: this.uuid(),
      idempotencyKey: `telegram-photo:${photo.updateId}`,
      occurredAt: this.now().toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: photo.telegramUserId },
      data: {
        telegramFileId: photo.fileId,
        telegramFileUniqueId: photo.fileUniqueId,
        ...(photo.fileSize === undefined ? {} : { declaredSizeBytes: photo.fileSize }),
        declaredMediaType: 'image/jpeg',
      },
    });
    return { handled: true, result };
  }
}

type TelegramPhotoManagementUseCases = Readonly<{
  list: Pick<ListOwnPhotosHandler, 'execute'>;
  mutate: Pick<MutateOwnPhotosHandler, 'execute'>;
}>;

type TelegramPhotoManagementUpdate = Readonly<{
  updateId: string;
  telegramUserId: string;
  callbackQueryId?: string;
}> &
  (
    | Readonly<{ action: 'list' }>
    | Readonly<{ action: OwnPhotoAction; expectedProfileVersion: number }>
  );

type TelegramPhotoActionTokenResolver = Readonly<{
  resolve(
    token: string,
    telegramUserId: string,
  ): Promise<Readonly<{ expectedProfileVersion: number; action: OwnPhotoAction }> | undefined>;
}>;

export type TelegramPhotoManagementResult =
  | Readonly<{ handled: false }>
  | Readonly<{
      handled: true;
      action: 'list' | OwnPhotoAction['type'];
      userId: string;
      telegramUserId: string;
      callbackQueryId?: string;
      collection: OwnPhotoCollection;
    }>;

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

function parsePhotoManagementUpdate(update: unknown): TelegramPhotoManagementUpdate | undefined {
  const root = record(update);
  const message = record(root?.message);
  const from = record(message?.from);
  const chat = record(message?.chat);
  const updateId = root?.update_id;
  const telegramUserId = from?.id;
  const text = message?.text;
  if (typeof text !== 'string' || !/^\/photos(?:_|\s|$)/u.test(text)) return undefined;
  if (text.length > 512)
    throw new ApplicationError('invalid_request', 'error.media.telegram_command_invalid', 400);
  if (
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    typeof telegramUserId !== 'number' ||
    !Number.isSafeInteger(telegramUserId) ||
    telegramUserId <= 0 ||
    chat?.type !== 'private' ||
    chat.id !== telegramUserId
  )
    throw new ApplicationError('invalid_request', 'error.media.telegram_command_invalid', 400);
  const base = { updateId: String(updateId), telegramUserId: String(telegramUserId) };
  if (text === '/photos') return { ...base, action: 'list' };
  const single = new RegExp(`^/photos_(primary|delete) (${UUID}) ([1-9][0-9]{0,9})$`, 'u').exec(
    text,
  );
  if (single !== null) {
    const version = Number(single[3]);
    if (!Number.isSafeInteger(version))
      throw new ApplicationError('invalid_request', 'error.media.telegram_command_invalid', 400);
    return {
      ...base,
      expectedProfileVersion: version,
      action: {
        type: single[1] === 'primary' ? 'select_primary' : 'delete',
        photoId: single[2]!,
      },
    };
  }
  const order = /^\/photos_order ([1-9][0-9]{0,9}) (\S+)$/u.exec(text);
  if (order !== null) {
    const version = Number(order[1]);
    const ids = order[2]!.split(',');
    const uuid = new RegExp(`^${UUID}$`, 'u');
    if (
      !Number.isSafeInteger(version) ||
      ids.length < 1 ||
      ids.length > 6 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !uuid.test(id))
    )
      throw new ApplicationError('invalid_request', 'error.media.telegram_command_invalid', 400);
    return {
      ...base,
      expectedProfileVersion: version,
      action: { type: 'reorder', orderedPhotoIds: ids },
    };
  }
  throw new ApplicationError('invalid_request', 'error.media.telegram_command_invalid', 400);
}

function parsePhotoManagementCallback(update: unknown):
  | Readonly<{
      updateId: string;
      telegramUserId: string;
      callbackQueryId: string;
      token: string;
    }>
  | undefined {
  const root = record(update);
  const callback = record(root?.callback_query);
  const from = record(callback?.from);
  const message = record(callback?.message);
  const chat = record(message?.chat);
  const data = callback?.data;
  if (typeof data !== 'string' || !data.startsWith('v1.pm.')) return undefined;
  const updateId = root?.update_id;
  const telegramUserId = from?.id;
  const callbackId = callback?.id;
  if (
    data.length > 64 ||
    typeof callbackId !== 'string' ||
    callbackId.length < 1 ||
    callbackId.length > 128 ||
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    typeof telegramUserId !== 'number' ||
    !Number.isSafeInteger(telegramUserId) ||
    telegramUserId <= 0 ||
    chat?.type !== 'private' ||
    chat.id !== telegramUserId
  )
    throw new ApplicationError('invalid_request', 'error.media.telegram_action_invalid', 400);
  return {
    updateId: String(updateId),
    telegramUserId: String(telegramUserId),
    callbackQueryId: callbackId,
    token: data,
  };
}

export class TelegramPhotoManagementAdapter {
  public constructor(
    private readonly resolver: TelegramUserResolver,
    private readonly useCases: TelegramPhotoManagementUseCases,
    private readonly rateLimiter?: RateLimiterPort,
    private readonly uuid: () => string = randomUUID,
    private readonly actionTokens?: TelegramPhotoActionTokenResolver,
  ) {}

  public async handle(update: unknown): Promise<TelegramPhotoManagementResult> {
    let parsed = parsePhotoManagementUpdate(update);
    if (parsed === undefined) {
      const callback = parsePhotoManagementCallback(update);
      if (callback === undefined) return { handled: false };
      const state = await this.actionTokens?.resolve(callback.token, callback.telegramUserId);
      if (state === undefined)
        throw new ApplicationError('invalid_request', 'error.media.telegram_action_invalid', 400);
      parsed = {
        updateId: callback.updateId,
        telegramUserId: callback.telegramUserId,
        callbackQueryId: callback.callbackQueryId,
        action: state.action,
        expectedProfileVersion: state.expectedProfileVersion,
      };
    }
    const userId = await this.resolver.resolveUserId(parsed.telegramUserId);
    if (userId === undefined)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const rate = await this.rateLimiter?.consume({
      scope: 'telegram_photo_management',
      subject: userId,
      limit: 30,
      windowSeconds: 60,
    });
    if (rate !== undefined && !rate.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429, {
        retryAfterSeconds: String(rate.retryAfterSeconds),
      });
    const actor = { kind: 'user' as const, userId };
    if (parsed.action === 'list')
      return {
        handled: true,
        action: 'list',
        userId,
        telegramUserId: parsed.telegramUserId,
        collection: await this.useCases.list.execute(actor),
      };
    return {
      handled: true,
      action: parsed.action.type,
      userId,
      telegramUserId: parsed.telegramUserId,
      ...(parsed.callbackQueryId === undefined ? {} : { callbackQueryId: parsed.callbackQueryId }),
      collection: await this.useCases.mutate.execute({
        actor,
        expectedProfileVersion: parsed.expectedProfileVersion,
        action: parsed.action,
        commandId: this.uuid(),
        requestId: this.uuid(),
        idempotencyKey: `telegram-update:${parsed.updateId}`,
      }),
    };
  }
}
