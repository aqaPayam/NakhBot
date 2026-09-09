import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '@nakh/domain';

import { ValidateQuarantinedPhoto } from './validation.js';

function body(value: number[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    yield new Uint8Array(value);
  })();
}

describe('ValidateQuarantinedPhoto', () => {
  it('publishes both verified renditions before completing database state', async () => {
    const complete = vi.fn().mockResolvedValue('valid');
    const put = vi.fn().mockImplementation((input: Readonly<{ key: string }>) =>
      Promise.resolve({
        bytes: 3,
        sha256: input.key.includes('thumbnail') ? 'c'.repeat(64) : 'b'.repeat(64),
      }),
    );
    const handler = new ValidateQuarantinedPhoto(
      {
        claim: () =>
          Promise.resolve({
            assetId: 'asset',
            quarantineKey: 'quarantine/test/asset/original',
            validatedKey: 'validated/test/asset/original',
            thumbnailKey: 'variants/test/asset/thumbnail-v1.webp',
          }),
        complete,
        reject: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
      { get: () => Promise.resolve(body([1, 2, 3])), put, delete: () => Promise.resolve() },
      {
        transform: () =>
          Promise.resolve({
            detectedMediaType: 'image/jpeg',
            width: 800,
            height: 700,
            frameCount: 1,
            originalBytes: 3,
            originalSha256: 'a'.repeat(64),
            normalizedSha256: 'b'.repeat(64),
            normalized: new Uint8Array([4, 5, 6]),
            thumbnail: new Uint8Array([7, 8, 9]),
          }),
      },
      () => new Date('2026-09-09T00:00:00.000Z'),
    );
    await handler.execute('asset', 'worker');
    expect(put).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'asset',
        owner: 'worker',
        normalizedSha256: 'b'.repeat(64),
        thumbnailSha256: 'c'.repeat(64),
      }),
    );
  });

  it('deletes completed external writes and releases the claim after database failure', async () => {
    const deleted: string[] = [];
    const released = vi.fn().mockResolvedValue(undefined);
    const handler = new ValidateQuarantinedPhoto(
      {
        claim: () =>
          Promise.resolve({
            assetId: 'asset',
            quarantineKey: 'q',
            validatedKey: 'validated',
            thumbnailKey: 'thumbnail',
          }),
        complete: () => Promise.reject(new Error('database unavailable')),
        reject: () => Promise.resolve(),
        release: released,
      },
      {
        get: () => Promise.resolve(body([1])),
        put: ({ key }) =>
          Promise.resolve({
            bytes: 1,
            sha256: key === 'validated' ? 'b'.repeat(64) : 'c'.repeat(64),
          }),
        delete: (key) => {
          deleted.push(key);
          return Promise.resolve();
        },
      },
      {
        transform: () =>
          Promise.resolve({
            detectedMediaType: 'image/png',
            width: 800,
            height: 800,
            frameCount: 1,
            originalBytes: 1,
            originalSha256: 'a'.repeat(64),
            normalizedSha256: 'b'.repeat(64),
            normalized: new Uint8Array([2]),
            thumbnail: new Uint8Array([3]),
          }),
      },
    );
    await expect(handler.execute('asset', 'worker')).rejects.toThrow('database unavailable');
    expect(deleted).toEqual(['thumbnail', 'validated']);
    expect(released).toHaveBeenCalledWith('asset', 'worker');
  });

  it('records a permanent decoder rejection without retrying the message', async () => {
    const reject = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const handler = new ValidateQuarantinedPhoto(
      {
        claim: () =>
          Promise.resolve({
            assetId: 'asset',
            quarantineKey: 'q',
            validatedKey: 'v',
            thumbnailKey: 't',
          }),
        complete: () => Promise.resolve('valid'),
        reject,
        release,
      },
      { get: () => Promise.resolve(body([1])), put: vi.fn(), delete: vi.fn() },
      { transform: () => Promise.reject(new ApplicationError('media_invalid', 'bad image', 400)) },
      () => new Date('2026-09-09T00:00:00.000Z'),
    );
    await expect(handler.execute('asset', 'worker')).resolves.toBeUndefined();
    expect(reject).toHaveBeenCalledWith({
      assetId: 'asset',
      owner: 'worker',
      errorCode: 'media_invalid',
      rejectedAt: new Date('2026-09-09T00:00:00.000Z'),
    });
    expect(release).not.toHaveBeenCalled();
  });

  it('removes unpublished renditions after a duplicate decision', async () => {
    const deleted: string[] = [];
    const handler = new ValidateQuarantinedPhoto(
      {
        claim: () =>
          Promise.resolve({
            assetId: 'asset',
            quarantineKey: 'q',
            validatedKey: 'v',
            thumbnailKey: 't',
          }),
        complete: () => Promise.resolve('duplicate_media'),
        reject: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
      {
        get: () => Promise.resolve(body([1])),
        put: ({ key }) =>
          Promise.resolve({
            bytes: 1,
            sha256: key === 'v' ? 'b'.repeat(64) : 'c'.repeat(64),
          }),
        delete: (key) => {
          deleted.push(key);
          return Promise.resolve();
        },
      },
      {
        transform: () =>
          Promise.resolve({
            detectedMediaType: 'image/jpeg',
            width: 800,
            height: 800,
            frameCount: 1,
            originalBytes: 1,
            originalSha256: 'a'.repeat(64),
            normalizedSha256: 'b'.repeat(64),
            normalized: new Uint8Array([2]),
            thumbnail: new Uint8Array([3]),
          }),
      },
    );
    await handler.execute('asset', 'worker');
    expect(deleted).toEqual(['t', 'v']);
  });

  it('cleans only completed writes and releases its claim at each storage failure point', async () => {
    for (const failingPut of [1, 2]) {
      const deleted: string[] = [];
      const release = vi.fn().mockResolvedValue(undefined);
      let puts = 0;
      const handler = new ValidateQuarantinedPhoto(
        {
          claim: () =>
            Promise.resolve({
              assetId: 'asset',
              quarantineKey: 'q',
              validatedKey: 'v',
              thumbnailKey: 't',
            }),
          complete: vi.fn(),
          reject: vi.fn(),
          release,
        },
        {
          get: () => Promise.resolve(body([1])),
          put: ({ key }) => {
            puts += 1;
            if (puts === failingPut) return Promise.reject(new Error('storage unavailable'));
            return Promise.resolve({
              bytes: 1,
              sha256: key === 'v' ? 'b'.repeat(64) : 'c'.repeat(64),
            });
          },
          delete: (key) => {
            deleted.push(key);
            return Promise.resolve();
          },
        },
        {
          transform: () =>
            Promise.resolve({
              detectedMediaType: 'image/jpeg',
              width: 800,
              height: 800,
              frameCount: 1,
              originalBytes: 1,
              originalSha256: 'a'.repeat(64),
              normalizedSha256: 'b'.repeat(64),
              normalized: new Uint8Array([2]),
              thumbnail: new Uint8Array([3]),
            }),
        },
      );
      await expect(handler.execute('asset', 'worker')).rejects.toThrow('storage unavailable');
      expect(deleted).toEqual(failingPut === 1 ? [] : ['v']);
      expect(release).toHaveBeenCalledWith('asset', 'worker');
    }
  });
});
