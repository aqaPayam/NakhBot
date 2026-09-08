import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  BeginPhotoIngestionResultSchema,
  BeginTelegramPhotoIngestionCommandSchema,
  MediaDeliveryGrantSchema,
  MediaValidationJobSchema,
  ReorderPhotosCommandSchema,
  ResolveMediaDeliveryGrantQuerySchema,
} from './index.js';

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;

function validator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const envelope = {
  commandId: '10000000-0000-4000-8000-000000000000',
  schemaVersion: 1,
  actor: { userId: '20000000-0000-4000-8000-000000000000', kind: 'user' },
  requestId: '30000000-0000-4000-8000-000000000000',
  idempotencyKey: 'stable-command-key',
  occurredAt: '2026-09-06T00:00:00.000Z',
  locale: 'en',
};

describe('M2 media contracts', () => {
  it('returns a durable coarse rejection with a stable reason and no transport metadata', () => {
    const validate = validator(BeginPhotoIngestionResultSchema);
    const result = {
      assetId: envelope.commandId,
      validationState: 'rejected',
      errorCode: 'media_too_large',
      acceptedAt: envelope.occurredAt,
      replayed: false,
    };
    expect(validate(result)).toBe(true);
    expect(validate({ ...result, validationState: 'pending' })).toBe(false);
    expect(validate({ ...result, errorCode: 'arbitrary-provider-detail' })).toBe(false);
    expect(validate({ ...result, telegramFileId: 'private-reference' })).toBe(false);
  });
  it('accepts bounded Telegram transport metadata without making it authoritative', () => {
    const validate = validator(BeginTelegramPhotoIngestionCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'media.begin-telegram-photo-ingestion',
        data: {
          telegramFileId: 'telegram-transport-reference',
          telegramFileUniqueId: 'telegram-stable-file-reference',
          declaredSizeBytes: 1024,
          declaredMediaType: 'image/jpeg',
        },
      }),
    ).toBe(true);
  });

  it('accepts untrusted oversized/type declarations but rejects unknown fields', () => {
    const validate = validator(BeginTelegramPhotoIngestionCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'media.begin-telegram-photo-ingestion',
        extra: true,
        data: {
          telegramFileId: 'file',
          telegramFileUniqueId: 'unique',
          declaredSizeBytes: 10 * 1024 * 1024 + 1,
          declaredMediaType: 'image/gif',
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...envelope,
        commandType: 'media.begin-telegram-photo-ingestion',
        data: {
          telegramFileId: 'file',
          telegramFileUniqueId: 'unique',
          declaredSizeBytes: 10 * 1024 * 1024 + 1,
          declaredMediaType: 'image/gif',
        },
      }),
    ).toBe(true);
  });

  it('requires complete duplicate-free photo ordering', () => {
    const validate = validator(ReorderPhotosCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'media.reorder-photos',
        data: {
          orderedPhotoIds: [envelope.commandId, envelope.commandId],
          expectedProfileVersion: 1,
        },
      }),
    ).toBe(false);
  });

  it('keeps worker messages versioned and strict', () => {
    const validate = validator(MediaValidationJobSchema);
    expect(
      validate({
        jobId: envelope.commandId,
        jobType: 'media.validate.v1',
        schemaVersion: 1,
        assetId: envelope.actor.userId,
        validationVersion: 1,
        occurredAt: envelope.occurredAt,
      }),
    ).toBe(true);
    expect(
      validate({
        jobId: envelope.commandId,
        jobType: 'media.thumbnail.v1',
        schemaVersion: 1,
        assetId: envelope.actor.userId,
        validationVersion: 1,
        occurredAt: envelope.occurredAt,
      }),
    ).toBe(false);
  });

  it('binds delivery requests to an actor, photo, purpose, and safe rendition', () => {
    const validate = validator(ResolveMediaDeliveryGrantQuerySchema);
    expect(
      validate({
        actor: envelope.actor,
        requestId: envelope.requestId,
        photoId: envelope.commandId,
        purpose: 'liked_by_blur',
        requestedVariant: 'blurred_preview',
      }),
    ).toBe(true);
    expect(
      validate({
        actor: envelope.actor,
        requestId: envelope.requestId,
        photoId: envelope.commandId,
        purpose: 'public-original',
        requestedVariant: 'original',
      }),
    ).toBe(false);
  });

  it('never exposes a storage key as a delivery grant', () => {
    const validate = validator(MediaDeliveryGrantSchema);
    expect(
      validate({
        deliveryUrl: 'https://media.example.invalid/g/token',
        expiresAt: '2026-09-06T00:05:00.000Z',
        variantType: 'thumbnail',
        cachePolicy: 'private',
      }),
    ).toBe(true);
    expect(
      validate({
        storageKey: 'validated/staging/asset/original',
        expiresAt: '2026-09-06T00:05:00.000Z',
        variantType: 'thumbnail',
        cachePolicy: 'private',
      }),
    ).toBe(false);
  });
});
