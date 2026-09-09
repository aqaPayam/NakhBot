import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { SharpPhotoTransformer } from './image-transformer.js';

describe('SharpPhotoTransformer', () => {
  it('sniffs, normalizes, strips metadata, and creates a bounded WebP thumbnail', async () => {
    const input = await sharp({
      create: { width: 800, height: 700, channels: 3, background: '#336699' },
    })
      .withMetadata({ orientation: 1, exif: { IFD0: { Copyright: 'must disappear' } } })
      .jpeg()
      .toBuffer();
    const result = await new SharpPhotoTransformer().transform(input);
    expect(result).toMatchObject({
      detectedMediaType: 'image/jpeg',
      width: 800,
      height: 700,
      frameCount: 1,
      originalBytes: input.byteLength,
    });
    expect(result.originalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.normalizedSha256).toMatch(/^[a-f0-9]{64}$/u);
    const normalized = await sharp(result.normalized).metadata();
    const thumbnail = await sharp(result.thumbnail).metadata();
    expect(normalized).toMatchObject({ format: 'webp', width: 800, height: 700 });
    expect(normalized.exif).toBeUndefined();
    expect(thumbnail).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(thumbnail.exif).toBeUndefined();
  });

  it('rejects dimensions below the locked minimum', async () => {
    const input = await sharp({
      create: { width: 599, height: 800, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    await expect(new SharpPhotoTransformer().transform(input)).rejects.toMatchObject({
      code: 'media_dimensions_invalid',
    });
  });

  it('rejects a decoded format outside JPEG, PNG, and WebP', async () => {
    const input = await sharp({
      create: { width: 800, height: 800, channels: 3, background: '#ffffff' },
    })
      .gif()
      .toBuffer();
    await expect(new SharpPhotoTransformer().transform(input)).rejects.toMatchObject({
      code: 'unsupported_media_type',
    });
  });

  it('rejects empty and oversized encoded inputs before decoding', async () => {
    const transformer = new SharpPhotoTransformer();
    await expect(transformer.transform(new Uint8Array())).rejects.toMatchObject({
      code: 'media_too_large',
    });
    await expect(transformer.transform(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toMatchObject(
      { code: 'media_too_large' },
    );
  });

  it.each([
    ['random bytes', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
    ['polyglot-like HTML', new TextEncoder().encode('<script>alert(1)</script>')],
  ])('fails closed for hostile %s input', async (_name, input) => {
    await expect(new SharpPhotoTransformer().transform(input)).rejects.toMatchObject({
      code: 'media_invalid',
    });
  });

  it('fails closed for a truncated otherwise-valid JPEG', async () => {
    const valid = await sharp({
      create: { width: 800, height: 800, channels: 3, background: '#884422' },
    })
      .jpeg()
      .toBuffer();
    const truncated = valid.subarray(0, Math.floor(valid.byteLength / 2));
    await expect(new SharpPhotoTransformer().transform(truncated)).rejects.toMatchObject({
      code: 'media_invalid',
    });
  });

  it('rejects a compressed image whose decoded pixel count exceeds the limit', async () => {
    const compressed = await sharp({
      create: { width: 6_500, height: 6_500, channels: 3, background: '#000000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(compressed.byteLength).toBeLessThan(10 * 1024 * 1024);
    await expect(new SharpPhotoTransformer().transform(compressed)).rejects.toMatchObject({
      code: 'media_dimensions_invalid',
    });
  });
});
