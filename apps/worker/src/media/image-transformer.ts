import { createHash } from 'node:crypto';

import type { PhotoRenditions, PhotoTransformerPort } from '@nakh/application';
import { ApplicationError, assertDecodedImage, MEDIA_LIMITS } from '@nakh/domain';
import sharp from 'sharp';

const formatTypes: Readonly<Record<string, PhotoRenditions['detectedMediaType'] | undefined>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The worker-only decoder boundary. Sharp/libvips enforces the pixel limit before
 * full decode; every accepted output is freshly oriented and encoded without metadata. */
export class SharpPhotoTransformer implements PhotoTransformerPort {
  public async transform(input: Uint8Array): Promise<PhotoRenditions> {
    if (input.byteLength <= 0 || input.byteLength > MEDIA_LIMITS.maximumUploadBytes)
      throw new ApplicationError('media_too_large', 'error.media.size', 400);
    const metadataOptions = {
      animated: true,
      // Header inspection does not decode pixel data. The domain validates dimensions
      // before the two decode operations below enforce the same hard pixel ceiling.
      limitInputPixels: false,
      failOn: 'warning' as const,
    };
    let metadata;
    try {
      metadata = await sharp(input, metadataOptions).metadata();
    } catch (error) {
      throw new ApplicationError('media_invalid', 'error.media.invalid', 400, {
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
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

    let normalized: Buffer;
    let thumbnail: Buffer;
    try {
      normalized = await sharp(input, {
        limitInputPixels: MEDIA_LIMITS.maximumPixels,
        failOn: 'warning',
      })
        .autoOrient()
        .toColourspace('srgb')
        .webp({ quality: 90, effort: 4, smartSubsample: true })
        .toBuffer();
      thumbnail = await sharp(normalized, {
        limitInputPixels: MEDIA_LIMITS.maximumPixels,
        failOn: 'warning',
      })
        .resize(512, 512, { fit: 'cover', position: 'attention', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4, smartSubsample: true })
        .toBuffer();
    } catch (error) {
      throw new ApplicationError('media_invalid', 'error.media.invalid', 400, {
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
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
