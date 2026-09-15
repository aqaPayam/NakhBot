import type {
  BeginTelegramPhotoIngestionCommand,
  BeginPhotoIngestionResult,
} from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type { RateLimiterPort } from '../security/rate-limit.js';

export interface MediaTransportEncryptor {
  encrypt(telegramFileId: string, assetId: string): Promise<Uint8Array>;
}

/** Resolves a provider identity only after the transport has authenticated the update. */
export interface TelegramUserResolver {
  resolveUserId(telegramUserId: string): Promise<string | undefined>;
}

/** Receives a validated command from an authenticated transport. Database policy
 * remains authoritative for account capability, replay, and the rolling limit. */
export class BeginTelegramPhotoIngestionHandler {
  public constructor(
    private readonly store: MediaIngestionStore,
    private readonly cipher: MediaTransportEncryptor,
    private readonly ids: IdGenerator,
    private readonly limiter: RateLimiterPort,
  ) {}

  public async execute(
    command: BeginTelegramPhotoIngestionCommand,
  ): Promise<BeginPhotoIngestionResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const rate = await this.limiter.consume({
      scope: 'telegram_photo_ingestion',
      subject: command.actor.userId,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rate.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429, {
        retryAfterSeconds: String(rate.retryAfterSeconds),
      });
    const assetId = this.ids.uuid();
    const transportMetadataCiphertext = await this.cipher.encrypt(
      command.data.telegramFileId,
      assetId,
    );
    return this.store.beginTelegramIngestion({
      command,
      assetId,
      transportMetadataCiphertext,
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}

/** Internal persistence input. PR3 supplies authenticated transport and authenticated encryption.
 * Never pass raw Telegram identifiers into ciphertext or expose this write as a public route. */
export type BeginMediaIngestionWrite = Readonly<{
  command: BeginTelegramPhotoIngestionCommand;
  transportMetadataCiphertext: Uint8Array;
  assetId: string;
  auditId: string;
  eventId: string;
}>;

export interface MediaIngestionStore {
  beginTelegramIngestion(write: BeginMediaIngestionWrite): Promise<BeginPhotoIngestionResult>;
}

export type TelegramMediaDownload = Readonly<{
  body: AsyncIterable<Uint8Array>;
  contentLength?: number;
  contentType?: string;
  cancel?: () => Promise<void>;
}>;

export interface TelegramMediaPort {
  download(fileId: string, signal?: AbortSignal): Promise<TelegramMediaDownload>;
}

export type PendingQuarantineAsset = Readonly<{
  assetId: string;
  quarantineKey: string;
  telegramFileId?: string;
  completed?: Readonly<{ bytes: number; sha256: string }>;
}>;

export interface QuarantineAssetStore {
  claimPendingQuarantine(
    input: Readonly<{ assetId: string; owner: string; leaseMs: number }>,
  ): Promise<PendingQuarantineAsset | undefined>;
  markQuarantineUploaded(
    input: Readonly<{
      assetId: string;
      bytes: number;
      sha256: string;
      uploadedAt: Date;
      owner: string;
      scannerVersion: string;
      signatureVersion: string;
      scannedAt: Date;
    }>,
  ): Promise<void>;
  markDownloadRejected(
    input: Readonly<{
      assetId: string;
      errorCode: 'media_too_large' | 'media_download_invalid' | 'malware_detected';
      failedAt: Date;
      owner: string;
    }>,
  ): Promise<void>;
  releaseQuarantineClaim(assetId: string, owner: string): Promise<void>;
}

export interface MediaTransportCipher {
  decrypt(ciphertext: Uint8Array, assetId: string): Promise<Readonly<{ telegramFileId: string }>>;
}

export interface QuarantineObjectPort {
  put(
    input: Readonly<{
      key: string;
      body: AsyncIterable<Uint8Array>;
      contentType: string;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{ bytes: number; sha256: string }>>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export type MalwareScanVerdict = Readonly<{
  result: 'clean' | 'detected';
  scannerVersion: string;
  signatureVersion: string;
}>;

export interface MalwareScanSession {
  inspect(chunk: Uint8Array): Promise<void>;
  complete(): Promise<MalwareScanVerdict>;
  abort(): Promise<void>;
}

export interface MalwareScannerPort {
  start(signal?: AbortSignal): Promise<MalwareScanSession>;
}

export class MediaDownloadError extends Error {
  public constructor(
    public readonly code: 'media_too_large' | 'media_download_invalid' | 'malware_detected',
  ) {
    super(code);
    this.name = 'MediaDownloadError';
  }
}

export class MediaScanError extends Error {
  public constructor() {
    super('media_scan_unavailable');
    this.name = 'MediaScanError';
  }
}

export async function* scannedMediaStream(
  source: AsyncIterable<Uint8Array>,
  session: MalwareScanSession,
): AsyncGenerator<Uint8Array, void, undefined> {
  for await (const chunk of source) {
    try {
      await session.inspect(chunk);
    } catch {
      throw new MediaScanError();
    }
    yield chunk;
  }
}

/** Adds a hard byte ceiling without buffering the provider response. The sink must consume
 * this iterator exactly once and must never publish an object before it completes. */
export async function* boundedMediaStream(
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  expectedBytes?: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  let bytes = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0)
      throw new MediaDownloadError('media_download_invalid');
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new MediaDownloadError('media_too_large');
    yield chunk;
  }
  if (bytes === 0 || (expectedBytes !== undefined && bytes !== expectedBytes))
    throw new MediaDownloadError('media_download_invalid');
}
