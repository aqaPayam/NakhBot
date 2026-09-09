import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { R2QuarantineObjectStore, type R2ObjectClient } from './index.js';

describe('R2QuarantineObjectStore', () => {
  it.each([undefined, { bytes: 2, sha256: 'a'.repeat(64) }, { bytes: 3, sha256: 'a'.repeat(64) }])(
    'refuses unverified storage facts %#',
    async (facts) => {
      const store = new R2QuarantineObjectStore({
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
      headObject: () =>
        Promise.resolve(++headCalls === 1 ? undefined : { bytes: 2, sha256: digest }),
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
});
