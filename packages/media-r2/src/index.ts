import { createHash } from 'node:crypto';
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
    return this.client.deleteObject(key, signal);
  }
}
