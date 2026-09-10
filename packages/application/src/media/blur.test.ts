import { describe, expect, it, vi } from 'vitest';

import { EnsureBlurredPreview } from './blur.js';

function body(): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    yield new Uint8Array([1, 2]);
  })();
}

describe('EnsureBlurredPreview', () => {
  it('returns an existing rendition without object access', async () => {
    const get = vi.fn();
    const handler = new EnsureBlurredPreview(
      {
        prepare: () => Promise.resolve({ status: 'ready', deliveryPath: '/media/ready.webp' }),
        complete: vi.fn(),
      },
      { get, put: vi.fn(), delete: vi.fn() },
      { transform: vi.fn() },
    );
    await expect(handler.execute('asset')).resolves.toBe('/media/ready.webp');
    expect(get).not.toHaveBeenCalled();
  });

  it('publishes only provider-verified facts under the deterministic key', async () => {
    const complete = vi.fn().mockResolvedValue('/media/blurred.webp');
    const handler = new EnsureBlurredPreview(
      {
        prepare: () =>
          Promise.resolve({
            status: 'pending',
            generation: {
              assetId: 'asset',
              sourceKey: 'validated/test/asset/original',
              blurredKey: 'variants/test/asset/blurred-preview-v1.webp',
              deliveryPath: '/media/asset/blurred-preview-v1.webp',
            },
          }),
        complete,
      },
      {
        get: () => Promise.resolve(body()),
        put: () => Promise.resolve({ bytes: 3, sha256: 'a'.repeat(64) }),
        delete: vi.fn(),
      },
      { transform: () => Promise.resolve(new Uint8Array([3, 4, 5])) },
      () => new Date('2026-09-10T00:00:00.000Z'),
    );
    await expect(handler.execute('asset')).resolves.toBe('/media/blurred.webp');
    expect(complete).toHaveBeenCalledWith({
      assetId: 'asset',
      blurredKey: 'variants/test/asset/blurred-preview-v1.webp',
      bytes: 3,
      sha256: 'a'.repeat(64),
      completedAt: new Date('2026-09-10T00:00:00.000Z'),
    });
  });

  it('rejects an empty transformer result before storage publication', async () => {
    const put = vi.fn();
    const handler = new EnsureBlurredPreview(
      {
        prepare: () =>
          Promise.resolve({
            status: 'pending',
            generation: {
              assetId: 'asset',
              sourceKey: 'validated/test/asset/original',
              blurredKey: 'variants/test/asset/blurred-preview-v1.webp',
              deliveryPath: '/media/asset/blurred-preview-v1.webp',
            },
          }),
        complete: vi.fn(),
      },
      { get: () => Promise.resolve(body()), put, delete: vi.fn() },
      { transform: () => Promise.resolve(new Uint8Array()) },
    );
    await expect(handler.execute('asset')).rejects.toThrow('media_blur_output_invalid');
    expect(put).not.toHaveBeenCalled();
  });
});
