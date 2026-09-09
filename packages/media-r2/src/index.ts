import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaStorePort, QuarantineObjectPort } from '@nakh/application';

export type R2Location = Readonly<{
  endpoint: string;
  bucket: string;
}>;

export class UnconfiguredR2MediaStore implements MediaStorePort {
  public put(): Promise<void> {
    return Promise.reject(new Error('The production R2 media adapter is configured in M2.'));
  }

  public delete(): Promise<void> {
    return Promise.reject(new Error('The production R2 media adapter is configured in M2.'));
  }

  public exists(): Promise<boolean> {
    return Promise.reject(new Error('The production R2 media adapter is configured in M2.'));
  }
}

export interface R2ObjectClient {
  putObject(
    input: Readonly<{
      key: string;
      body: AsyncIterable<Uint8Array>;
      contentType: string;
      ifNoneMatch: '*';
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{ bytes: number; sha256: string }>>;
  deleteObject(key: string, signal?: AbortSignal): Promise<void>;
  headObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ bytes: number; sha256: string }> | undefined>;
}

export type AwsR2ClientConfig = Readonly<{
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  temporaryDirectory?: string;
}>;

interface S3CommandSender {
  send(
    command: PutObjectCommand | HeadObjectCommand | DeleteObjectCommand,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown>;
}

function assertR2Endpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.r2\.cloudflarestorage\.com$/u.test(url.hostname)
  )
    throw new Error('invalid_r2_endpoint');
  return url.origin;
}

function requestOptions(signal: AbortSignal | undefined): { abortSignal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { abortSignal: signal };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Readonly<{
    name?: unknown;
    $metadata?: Readonly<{ httpStatusCode?: unknown }>;
  }>;
  return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

/** Real Cloudflare R2 transport. Incoming media is spooled to bounded worker temporary
 * storage so its checksum and length are known before the signed upload begins. */
export class AwsR2ObjectClient implements R2ObjectClient {
  private readonly bucket: string;
  private readonly temporaryDirectory: string;
  private readonly client: S3CommandSender;

  public constructor(config: AwsR2ClientConfig, client?: S3CommandSender) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket))
      throw new Error('invalid_r2_bucket');
    if (config.accessKeyId.length === 0 || config.secretAccessKey.length === 0)
      throw new Error('invalid_r2_credentials');
    this.bucket = config.bucket;
    this.temporaryDirectory = config.temporaryDirectory ?? tmpdir();
    this.client =
      client ??
      new S3Client({
        region: 'auto',
        endpoint: assertR2Endpoint(config.endpoint),
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    if (client !== undefined) assertR2Endpoint(config.endpoint);
  }

  public async putObject(
    input: Readonly<{
      key: string;
      body: AsyncIterable<Uint8Array>;
      contentType: string;
      ifNoneMatch: '*';
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{ bytes: number; sha256: string }>> {
    const directory = await mkdtemp(join(this.temporaryDirectory, 'nakh-r2-'));
    const path = join(directory, 'payload');
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.from(input.body), meter, createWriteStream(path), {
        signal: input.signal,
      });
      if (bytes <= 0) throw new Error('media_storage_stream_incomplete');
      const sha256 = hash.digest('hex');
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: createReadStream(path),
          ContentLength: bytes,
          ContentType: input.contentType,
          IfNoneMatch: input.ifNoneMatch,
          Metadata: { 'nakh-sha256': sha256 },
        }),
        requestOptions(input.signal),
      );
      return { bytes, sha256 };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  public async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      requestOptions(signal),
    );
  }

  public async headObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ bytes: number; sha256: string }> | undefined> {
    try {
      const output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        requestOptions(signal),
      );
      if (
        typeof output !== 'object' ||
        output === null ||
        !('ContentLength' in output) ||
        !('Metadata' in output) ||
        typeof output.ContentLength !== 'number' ||
        !Number.isSafeInteger(output.ContentLength) ||
        typeof output.Metadata !== 'object' ||
        output.Metadata === null
      )
        throw new Error('media_storage_metadata_invalid');
      const sha256 = (output.Metadata as Readonly<Record<string, unknown>>)['nakh-sha256'];
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256))
        throw new Error('media_storage_metadata_invalid');
      return { bytes: output.ContentLength, sha256 };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}

/** Maps the application quarantine port to an S3-compatible R2 client. Signing,
 * credentials, and HTTP transport live behind R2ObjectClient so they cannot leak
 * into domain/application code. */
export class R2QuarantineObjectStore implements QuarantineObjectPort {
  public constructor(private readonly client: R2ObjectClient) {}

  public async put(
    input: Readonly<{
      key: string;
      body: AsyncIterable<Uint8Array>;
      contentType: string;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{ bytes: number; sha256: string }>> {
    const existing = await this.client.headObject(input.key, input.signal);
    const hash = createHash('sha256');
    let bytes = 0;
    let consumed = false;
    const body = (async function* () {
      for await (const chunk of input.body) {
        bytes += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
      consumed = true;
    })();
    try {
      if (existing === undefined) await this.client.putObject({ ...input, body, ifNoneMatch: '*' });
      else for await (const chunk of body) void chunk;
      if (!consumed || bytes === 0) throw new Error('media_storage_stream_incomplete');
      const sha256 = hash.digest('hex');
      const stored = existing ?? (await this.client.headObject(input.key, input.signal));
      if (stored?.bytes !== bytes || stored.sha256 !== sha256)
        throw new Error('media_storage_verification_failed');
      return { bytes, sha256 };
    } finally {
      await body.return();
    }
  }

  public delete(key: string, signal?: AbortSignal): Promise<void> {
    return this.deleteAndVerify(key, signal);
  }

  private async deleteAndVerify(key: string, signal?: AbortSignal): Promise<void> {
    await this.client.deleteObject(key, signal);
    if ((await this.client.headObject(key, signal)) !== undefined)
      throw new Error('media_storage_delete_verification_failed');
  }
}
