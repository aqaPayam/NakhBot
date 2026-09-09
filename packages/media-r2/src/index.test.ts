import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
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

  it('maps only a definite not-found HEAD response to absence', async () => {
    const notFound = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const missing = new AwsR2ObjectClient(config, {
      send: (command) => {
        expect(command).toBeInstanceOf(HeadObjectCommand);
        return Promise.reject(notFound);
      },
    });
    await expect(missing.headObject('key')).resolves.toBeUndefined();

    const unknown = new AwsR2ObjectClient(config, {
      send: () => Promise.reject(new Error('timeout')),
    });
    await expect(unknown.headObject('key')).rejects.toThrow('timeout');
  });

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

  it('rejects endpoints outside the Cloudflare R2 service origin', () => {
    expect(
      () => new AwsR2ObjectClient({ ...config, endpoint: 'https://attacker.example' }, { send }),
    ).toThrow('invalid_r2_endpoint');
  });
});

function send(): Promise<never> {
  return Promise.reject(new Error('not used'));
}
