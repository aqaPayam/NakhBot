import { createHash } from 'node:crypto';

import { assertDecodedImage, MEDIA_LIMITS, type AcceptedMediaType } from '@nakh/domain';
import sharp from 'sharp';

export type ValidatedPhotoRenditions = Readonly<{
  detectedMediaType: AcceptedMediaType;
  width: number;
  height: number;
  frameCount: 1;
  originalBytes: number;
  originalSha256: string;
  normalizedSha256: string;
  normalized: Uint8Array;
  thumbnail: Uint8Array;
}>;

const formatTypes: Readonly<Record<string, AcceptedMediaType | undefined>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The worker-only decoder boundary. Sharp/libvips enforces the pixel limit before
 * full decode; every accepted output is freshly oriented and encoded without metadata. */
export class SharpPhotoTransformer {
  public async transform(input: Uint8Array): Promise<ValidatedPhotoRenditions> {
    if (input.byteLength <= 0 || input.byteLength > MEDIA_LIMITS.maximumUploadBytes)
      throw new Error('media_input_size_invalid');
    const metadataOptions = {
      animated: true,
      limitInputPixels: MEDIA_LIMITS.maximumPixels,
      failOn: 'warning' as const,
    };
    const metadata = await sharp(input, metadataOptions).metadata();
    const detectedMediaType =
      metadata.format === undefined ? undefined : formatTypes[metadata.format];
    const width = metadata.autoOrient.width;
    const height = metadata.autoOrient.height;
    const frameCount = metadata.pages ?? 1;
    const decoded = {
      mediaType: detectedMediaType ?? 'unsupported',
      sizeBytes: input.byteLength,
      width,
      height,
      frameCount,
    };
    assertDecodedImage(decoded);

    const normalized = await sharp(input, {
      limitInputPixels: MEDIA_LIMITS.maximumPixels,
      failOn: 'warning',
    })
      .autoOrient()
      .toColourspace('srgb')
      .webp({ quality: 90, effort: 4, smartSubsample: true })
      .toBuffer();
    const thumbnail = await sharp(normalized, {
      limitInputPixels: MEDIA_LIMITS.maximumPixels,
      failOn: 'warning',
    })
      .resize(512, 512, { fit: 'cover', position: 'attention', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4, smartSubsample: true })
      .toBuffer();
    return {
      detectedMediaType: decoded.mediaType,
      width,
      height,
      frameCount: 1,
      originalBytes: input.byteLength,
      originalSha256: digest(input),
      normalizedSha256: digest(normalized),
      normalized,
      thumbnail,
    };
  }
}
