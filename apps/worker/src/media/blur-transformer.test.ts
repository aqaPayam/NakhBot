import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { SharpBlurTransformer } from './blur-transformer.js';

describe('SharpBlurTransformer', () => {
  it('creates a small metadata-free WebP rendition', async () => {
    const input = await sharp({
      create: {
        width: 800,
        height: 700,
        channels: 3,
        background: '#884422',
      },
    })
      .withMetadata({ exif: { IFD0: { Copyright: 'remove' } } })
      .webp()
      .toBuffer();
    const output = await new SharpBlurTransformer().transform(input);
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 96, height: 96 });
    expect(metadata.exif).toBeUndefined();
    expect(output.byteLength).toBeLessThan(input.byteLength);
  });
});
