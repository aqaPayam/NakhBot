import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { DeletePhotoMediaObjects, type MediaCleanupStore } from '@nakh/application';
import { AwsR2ObjectClient, R2QuarantineObjectStore, type R2ObjectClient } from './index.js';

describe('R2QuarantineObjectStore', () => {
  it.each([undefined, { bytes: 2, sha256: 'a'.repeat(64) }, { bytes: 3, sha256: 'a'.repeat(64) }])(
    'refuses unverified storage facts %#',
    async (facts) => {
      const store = new R2QuarantineObjectStore({
        getObject: () => Promise.reject(new Error('not used')),
        putObject: async ({ body }) => {
          for await (const chunk of body) void chunk;
          return { bytes: 2, sha256: 'a'.repeat(64) };
        },
        headObject: () => Promise.resolve(facts),
        deleteObject: () => Promise.resolve(),
      });
      await expect(
        store.put({
          key: 'quarantine/test/a/original',
          contentType: 'application/octet-stream',
          body: (async function* () {
            await Promise.resolve();
            yield new Uint8Array([1, 2]);
          })(),
        }),
      ).rejects.toThrow('media_storage_verification_failed');
    },
  );

  it('passes the exact private key and streaming body to the provider client', async () => {
    const calls: string[] = [];
    const digest = createHash('sha256')
      .update(new Uint8Array([1, 2]))
      .digest('hex');
    let headCalls = 0;
    const client: R2ObjectClient = {
      getObject: () => Promise.reject(new Error('not used')),
      putObject: async (input) => {
        calls.push(input.key);
        expect(input.ifNoneMatch).toBe('*');
        let bytes = 0;
        for await (const chunk of input.body) bytes += chunk.byteLength;
        return { bytes, sha256: 'a'.repeat(64) };
      },
      deleteObject: (key) => {
        calls.push(`delete:${key}`);
        return Promise.resolve();
      },
      headObject: () => {
        headCalls += 1;
        return Promise.resolve(headCalls === 2 ? { bytes: 2, sha256: digest } : undefined);
      },
    };
    const store = new R2QuarantineObjectStore(client);
    await expect(
      store.put({
        key: 'quarantine/staging/asset-1/original',
        body: (async function* () {
          await Promise.resolve();
          yield new Uint8Array([1, 2]);
        })(),
        contentType: 'application/octet-stream',
      }),
    ).resolves.toEqual({ bytes: 2, sha256: digest });
    await store.delete('quarantine/staging/asset-1/original');
    expect(calls).toEqual([
      'quarantine/staging/asset-1/original',
      'delete:quarantine/staging/asset-1/original',
    ]);
  });

  it('reconciles an existing object by consuming and hashing the new stream without overwriting', async () => {
    const digest = createHash('sha256')
      .update(new Uint8Array([1, 2]))
      .digest('hex');
    let puts = 0;
    const store = new R2QuarantineObjectStore({
      getObject: () => Promise.reject(new Error('not used')),
      putObject: () => {
        puts += 1;
        return Promise.reject(new Error('must not overwrite'));
      },
      headObject: () => Promise.resolve({ bytes: 2, sha256: digest }),
      deleteObject: () => Promise.resolve(),
    });
    await expect(
      store.put({
        key: 'quarantine/test/a/original',
        contentType: 'application/octet-stream',
        body: (async function* () {
          await Promise.resolve();
          yield new Uint8Array([1, 2]);
        })(),
      }),
    ).resolves.toEqual({ bytes: 2, sha256: digest });
    expect(puts).toBe(0);
  });

  it('fails closed when deletion cannot be verified', async () => {
    const store = new R2QuarantineObjectStore({
      getObject: () => Promise.reject(new Error('not used')),
      putObject: () => Promise.reject(new Error('not used')),
      deleteObject: () => Promise.resolve(),
      headObject: () => Promise.resolve({ bytes: 1, sha256: 'a'.repeat(64) }),
    });
    await expect(store.delete('quarantine/test/a/original')).rejects.toThrow(
      'media_storage_delete_verification_failed',
    );
  });
});

describe('AwsR2ObjectClient', () => {
  const config = {
    endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'nakh-staging',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  };

  it('spools a bounded stream and uploads with immutable checksum metadata', async () => {
    const calls: string[] = [];
    const digest = createHash('sha256')
      .update(new Uint8Array([1, 2, 3]))
      .digest('hex');
    const client = new AwsR2ObjectClient(config, {
      send: async (command) => {
        if (!(command instanceof PutObjectCommand)) throw new Error('unexpected command');
        calls.push(command.input.Key ?? '');
        expect(command.input).toMatchObject({
          Bucket: 'nakh-staging',
          Key: 'quarantine/staging/asset/original',
          ContentLength: 3,
          ContentType: 'application/octet-stream',
          IfNoneMatch: '*',
          Metadata: { 'nakh-sha256': digest },
        });
        let bytes = 0;
        for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>)
          bytes += chunk.byteLength;
        expect(bytes).toBe(3);
        return {};
      },
    });
    await expect(
      client.putObject({
        key: 'quarantine/staging/asset/original',
        body: (async function* () {
          await Promise.resolve();
          yield new Uint8Array([1, 2, 3]);
        })(),
        contentType: 'application/octet-stream',
        ifNoneMatch: '*',
      }),
    ).resolves.toEqual({ bytes: 3, sha256: digest });
    expect(calls).toEqual(['quarantine/staging/asset/original']);
  });

  it('returns the provider download stream without buffering it', async () => {
    const stream = (async function* () {
      await Promise.resolve();
      yield new Uint8Array([1, 2]);
    })();
    const client = new AwsR2ObjectClient(config, {
      send: (command) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return Promise.resolve({ Body: stream });
      },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of await client.getObject('quarantine/test/asset/original'))
      chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([1, 2])]);
  });

  it('fails closed when the provider omits a streaming response body', async () => {
    const client = new AwsR2ObjectClient(config, {
      send: () => Promise.resolve({ Body: new Uint8Array([1, 2]) }),
    });
    await expect(client.getObject('quarantine/test/asset/original')).rejects.toThrow(
      'media_storage_body_invalid',
    );
  });

  it('maps an exact object not-found response to absence only after checking the same bucket', async () => {
    const notFound = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const signal = new AbortController().signal;
    const commands: string[] = [];
    const missing = new AwsR2ObjectClient(config, {
      send: (command, options) => {
        expect(options?.abortSignal).toBe(signal);
        expect(command.input.Bucket).toBe(config.bucket);
        if (command instanceof HeadBucketCommand) {
          commands.push('bucket');
          return Promise.resolve({ $metadata: { httpStatusCode: 200 } });
        }
        expect(command).toBeInstanceOf(HeadObjectCommand);
        commands.push('object');
        return Promise.reject(notFound);
      },
    });
    await expect(missing.headObject('key', signal)).resolves.toBeUndefined();
    expect(commands).toEqual(['object', 'bucket']);

    const unknown = new AwsR2ObjectClient(config, {
      send: () => Promise.reject(new Error('timeout')),
    });
    await expect(unknown.headObject('key')).rejects.toThrow('timeout');
  });

  it.each([
    { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
    { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
    { name: 'NotFound', $metadata: { httpStatusCode: 500 } },
    { name: 'NotFound' },
    { $metadata: { httpStatusCode: 404 } },
  ])('never turns ambiguous provider or bucket errors into absence %#', async (facts) => {
    const failure = Object.assign(new Error('provider failure'), facts);
    let calls = 0;
    const client = new AwsR2ObjectClient(config, {
      send: () => {
        calls += 1;
        return Promise.reject(failure);
      },
    });
    await expect(client.headObject('private/key')).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it.each([
    new Error('bucket unavailable'),
    Object.assign(new Error('bucket denied'), { $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error('bucket absent'), { $metadata: { httpStatusCode: 404 } }),
  ])('preserves a failed bucket verification as a retryable error %#', async (failure) => {
    const client = new AwsR2ObjectClient(config, {
      send: (command) => {
        if (command instanceof HeadObjectCommand)
          return Promise.reject(
            Object.assign(new Error('object absent'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            }),
          );
        expect(command).toBeInstanceOf(HeadBucketCommand);
        return Promise.reject(failure);
      },
    });
    await expect(client.headObject('private/key')).rejects.toBe(failure);
  });

  it.each([undefined, {}, { $metadata: {} }, { $metadata: { httpStatusCode: 204 } }])(
    'rejects incomplete bucket verification without claiming absence %#',
    async (bucket) => {
      const client = new AwsR2ObjectClient(config, {
        send: (command) => {
          if (command instanceof HeadBucketCommand) return Promise.resolve(bucket);
          return Promise.reject(
            Object.assign(new Error('object absent'), {
              name: 'NoSuchKey',
              $metadata: { httpStatusCode: 404 },
            }),
          );
        },
      });
      await expect(client.headObject('private/key')).rejects.toThrow(
        'media_storage_bucket_verification_failed',
      );
    },
  );

  it.each(['object_remains', 'bucket_unavailable'] as const)(
    'the actual cleanup composition cannot complete after %s and safely retries partial deletion',
    async (initialFailure) => {
      const assetId = '20000000-0000-4000-8000-000000000002';
      const photoId = '10000000-0000-4000-8000-000000000001';
      const keys = [
        `variants/test/${assetId}/thumbnail-v1.webp`,
        `validated/test/${assetId}/original`,
        `quarantine/test/${assetId}/original`,
      ];
      const remaining = new Set(keys);
      const checked: string[] = [];
      let failure: typeof initialFailure | undefined = initialFailure;
      let completions = 0,
        releases = 0,
        bucketChecks = 0;
      const store: MediaCleanupStore = {
        claimPhoto: () => Promise.resolve({ assetId, deletionGeneration: 4, objectKeys: keys }),
        complete: () => {
          expect(remaining.size).toBe(0);
          expect(checked).toEqual(keys);
          completions += 1;
          return Promise.resolve();
        },
        release: () => {
          releases += 1;
          return Promise.resolve();
        },
      };
      const objects = new R2QuarantineObjectStore(
        new AwsR2ObjectClient(config, {
          send: (command, options) => {
            expect(command.input.Bucket).toBe(config.bucket);
            expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
            if (command instanceof DeleteObjectCommand) {
              if (failure !== 'object_remains') remaining.delete(command.input.Key!);
              return Promise.resolve({});
            }
            if (command instanceof HeadObjectCommand) {
              if (remaining.has(command.input.Key!))
                return Promise.resolve({
                  ContentLength: 42,
                  Metadata: { 'nakh-sha256': 'a'.repeat(64) },
                });
              checked.push(command.input.Key!);
              return Promise.reject(
                Object.assign(new Error('object absent'), {
                  name: 'NotFound',
                  $metadata: { httpStatusCode: 404 },
                }),
              );
            }
            expect(command).toBeInstanceOf(HeadBucketCommand);
            bucketChecks += 1;
            if (failure === 'bucket_unavailable')
              return Promise.reject(new Error('bucket unavailable'));
            return Promise.resolve({ $metadata: { httpStatusCode: 200 } });
          },
        }),
      );
      const handler = new DeletePhotoMediaObjects(store, objects, 'test');
      await expect(handler.execute(photoId, 'worker-1')).rejects.toThrow(
        initialFailure === 'object_remains'
          ? 'media_storage_delete_verification_failed'
          : 'bucket unavailable',
      );
      expect(completions).toBe(0);
      expect(releases).toBe(1);
      failure = undefined;
      checked.length = 0;
      await handler.execute(photoId, 'worker-2');
      expect(completions).toBe(1);
      expect(releases).toBe(1);
      expect(bucketChecks).toBe(initialFailure === 'bucket_unavailable' ? 4 : 3);
    },
  );

  it('reads verified facts and sends exact-key deletes', async () => {
    const digest = 'b'.repeat(64);
    const commands: string[] = [];
    const client = new AwsR2ObjectClient(config, {
      send: (command) => {
        if (command instanceof HeadObjectCommand) {
          commands.push(`head:${command.input.Key}`);
          return Promise.resolve({
            ContentLength: 42,
            Metadata: { 'nakh-sha256': digest },
          });
        }
        if (command instanceof DeleteObjectCommand) {
          commands.push(`delete:${command.input.Key}`);
          return Promise.resolve({});
        }
        return Promise.reject(new Error('unexpected command'));
      },
    });
    await expect(client.headObject('private/key')).resolves.toEqual({ bytes: 42, sha256: digest });
    await client.deleteObject('private/key');
    expect(commands).toEqual(['head:private/key', 'delete:private/key']);
  });

  it('lists one bounded private-prefix page without trusting malformed provider facts', async () => {
    const client = new AwsR2ObjectClient(config, {
      send: (command) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        expect(command.input).toMatchObject({
          Bucket: 'nakh-staging',
          Prefix: 'variants/staging/',
          MaxKeys: 100,
        });
        return Promise.resolve({
          Contents: [
            {
              Key: 'variants/staging/20000000-0000-4000-8000-000000000002/thumbnail-v1.webp',
              LastModified: new Date('2026-09-10T00:00:00.000Z'),
            },
          ],
          IsTruncated: true,
          NextContinuationToken: 'next-page',
        });
      },
    });
    await expect(client.listObjects({ prefix: 'variants/staging/', limit: 100 })).resolves.toEqual({
      objects: [
        {
          key: 'variants/staging/20000000-0000-4000-8000-000000000002/thumbnail-v1.webp',
          lastModified: new Date('2026-09-10T00:00:00.000Z'),
        },
      ],
      nextCursor: 'next-page',
    });
  });

  it('rejects unsafe list prefixes and malformed listing responses', async () => {
    const send = (): Promise<unknown> =>
      Promise.resolve({ Contents: [{ Key: 'variants/test/foreign' }] });
    const client = new AwsR2ObjectClient(config, { send });
    await expect(
      client.listObjects({ prefix: 'report-evidence/test/', limit: 10 }),
    ).rejects.toThrow('invalid_media_object_listing');
    await expect(client.listObjects({ prefix: 'variants/test/', limit: 10 })).rejects.toThrow(
      'media_storage_listing_invalid',
    );
  });

  it('rejects endpoints outside the Cloudflare R2 service origin', () => {
    expect(
      () => new AwsR2ObjectClient({ ...config, endpoint: 'https://attacker.example' }, { send }),
    ).toThrow('invalid_r2_endpoint');
  });
});

function send(): Promise<never> {
  return Promise.reject(new Error('not used'));
}
