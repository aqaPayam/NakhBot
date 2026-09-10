import type { MediaValidationObjectPort } from './validation.js';

export type PendingBlurGeneration = Readonly<{
  assetId: string;
  sourceKey: string;
  blurredKey: string;
  deliveryPath: string;
}>;

export interface BlurTransformerPort {
  transform(input: Uint8Array): Promise<Uint8Array>;
}

export interface BlurGenerationStore {
  prepare(
    assetId: string,
  ): Promise<
    | Readonly<{ status: 'ready'; deliveryPath: string }>
    | Readonly<{ status: 'pending'; generation: PendingBlurGeneration }>
  >;
  complete(
    input: Readonly<{
      assetId: string;
      blurredKey: string;
      bytes: number;
      sha256: string;
      completedAt: Date;
    }>,
  ): Promise<string>;
}

function stream(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    yield value;
  })();
}

async function collect(
  source: AsyncIterable<Uint8Array>,
  maximumBytes = 10 * 1024 * 1024,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0 ||
      length + chunk.byteLength > maximumBytes
    )
      throw new Error('media_storage_body_invalid');
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  if (length === 0) throw new Error('media_storage_body_invalid');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class EnsureBlurredPreview {
  public constructor(
    private readonly store: BlurGenerationStore,
    private readonly objects: MediaValidationObjectPort,
    private readonly transformer: BlurTransformerPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(assetId: string, signal?: AbortSignal): Promise<string> {
    const prepared = await this.store.prepare(assetId);
    if (prepared.status === 'ready') return prepared.deliveryPath;
    const input = await collect(await this.objects.get(prepared.generation.sourceKey, signal));
    const blurred = await this.transformer.transform(input);
    if (
      !(blurred instanceof Uint8Array) ||
      blurred.byteLength === 0 ||
      blurred.byteLength > 1024 * 1024
    )
      throw new Error('media_blur_output_invalid');
    const stored = await this.objects.put({
      key: prepared.generation.blurredKey,
      body: stream(blurred),
      contentType: 'image/webp',
      ...(signal === undefined ? {} : { signal }),
    });
    return this.store.complete({
      assetId,
      blurredKey: prepared.generation.blurredKey,
      bytes: stored.bytes,
      sha256: stored.sha256,
      completedAt: this.now(),
    });
  }
}
