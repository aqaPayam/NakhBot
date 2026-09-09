import { MEDIA_LIMITS, type AcceptedMediaType } from '@nakh/domain';

import { boundedMediaStream } from './ingestion.js';

export type PendingMediaValidation = Readonly<{
  assetId: string;
  quarantineKey: string;
  validatedKey: string;
  thumbnailKey: string;
}>;

export type PhotoRenditions = Readonly<{
  detectedMediaType: AcceptedMediaType;
  width: number;
  height: number;
  frameCount: 1;
  originalBytes: number;
  originalSha256: string;
  normalizedSha256: string;
  normalized: Uint8Array;
  thumbnail: Uint8Array;
}>;

export interface PhotoTransformerPort {
  transform(input: Uint8Array): Promise<PhotoRenditions>;
}

export interface MediaValidationObjectPort {
  get(key: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
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

export interface MediaValidationStore {
  claim(
    input: Readonly<{ assetId: string; owner: string; leaseMs: number }>,
  ): Promise<PendingMediaValidation | undefined>;
  complete(
    input: Readonly<{
      assetId: string;
      owner: string;
      detectedMediaType: AcceptedMediaType;
      sizeBytes: number;
      width: number;
      height: number;
      originalSha256: string;
      normalizedSha256: string;
      validatedKey: string;
      thumbnailKey: string;
      thumbnailBytes: number;
      thumbnailSha256: string;
      completedAt: Date;
    }>,
  ): Promise<void>;
  release(assetId: string, owner: string): Promise<void>;
}

function bytes(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    yield value;
  })();
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of boundedMediaStream(source, MEDIA_LIMITS.maximumUploadBytes)) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class ValidateQuarantinedPhoto {
  public constructor(
    private readonly store: MediaValidationStore,
    private readonly objects: MediaValidationObjectPort,
    private readonly transformer: PhotoTransformerPort,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 120_000,
  ) {}

  public async execute(assetId: string, owner: string, signal?: AbortSignal): Promise<void> {
    const claim = await this.store.claim({ assetId, owner, leaseMs: this.leaseMs });
    if (claim === undefined) return;
    let normalizedWritten = false;
    let thumbnailWritten = false;
    try {
      const input = await collect(await this.objects.get(claim.quarantineKey, signal));
      const result = await this.transformer.transform(input);
      if (result.originalBytes !== input.byteLength)
        throw new Error('media_validation_facts_invalid');
      const normalized = await this.objects.put({
        key: claim.validatedKey,
        body: bytes(result.normalized),
        contentType: 'image/webp',
        ...(signal === undefined ? {} : { signal }),
      });
      normalizedWritten = true;
      if (normalized.sha256 !== result.normalizedSha256)
        throw new Error('media_validation_facts_invalid');
      const thumbnail = await this.objects.put({
        key: claim.thumbnailKey,
        body: bytes(result.thumbnail),
        contentType: 'image/webp',
        ...(signal === undefined ? {} : { signal }),
      });
      thumbnailWritten = true;
      await this.store.complete({
        assetId,
        owner,
        detectedMediaType: result.detectedMediaType,
        sizeBytes: result.originalBytes,
        width: result.width,
        height: result.height,
        originalSha256: result.originalSha256,
        normalizedSha256: result.normalizedSha256,
        validatedKey: claim.validatedKey,
        thumbnailKey: claim.thumbnailKey,
        thumbnailBytes: thumbnail.bytes,
        thumbnailSha256: thumbnail.sha256,
        completedAt: this.now(),
      });
    } catch (error) {
      if (thumbnailWritten) await this.objects.delete(claim.thumbnailKey, signal);
      if (normalizedWritten) await this.objects.delete(claim.validatedKey, signal);
      await this.store.release(assetId, owner);
      throw error;
    }
  }
}
