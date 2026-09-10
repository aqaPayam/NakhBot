import type { BlurTransformerPort } from '@nakh/application';
import sharp from 'sharp';

export class SharpBlurTransformer implements BlurTransformerPort {
  public async transform(input: Uint8Array): Promise<Uint8Array> {
    if (input.byteLength === 0 || input.byteLength > 10 * 1024 * 1024)
      throw new Error('media_blur_input_invalid');
    return sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' })
      .resize(96, 96, { fit: 'cover', position: 'attention', withoutEnlargement: true })
      .blur(12)
      .webp({ quality: 55, effort: 4 })
      .toBuffer();
  }
}
