import {
  Type,
  type Static,
  type TLiteral,
  type TObject,
  type TOptional,
  type TSchema,
  type TString,
} from '@sinclair/typebox';

import { ActorSchema, ChannelContextSchema, UtcTimestampSchema, UuidSchema } from './shared.js';

const detectedMediaTypeSchema = Type.Union([
  Type.Literal('image/jpeg'),
  Type.Literal('image/png'),
  Type.Literal('image/webp'),
]);

export const MediaValidationStateSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('valid'),
  Type.Literal('rejected'),
  Type.Literal('failed'),
]);

export const PhotoStatusSchema = Type.Union([
  Type.Literal('visible'),
  Type.Literal('hidden'),
  Type.Literal('deleted'),
]);

export const PhotoVariantTypeSchema = Type.Union([
  Type.Literal('thumbnail'),
  Type.Literal('blurred_preview'),
]);

type CommandProperties<TType extends string, TData extends TSchema> = {
  commandId: typeof UuidSchema;
  commandType: TLiteral<TType>;
  schemaVersion: TLiteral<1>;
  actor: typeof ActorSchema;
  requestId: typeof UuidSchema;
  idempotencyKey: TString;
  occurredAt: typeof UtcTimestampSchema;
  locale: TString;
  channelContext: TOptional<typeof ChannelContextSchema>;
  data: TData;
};

function commandSchema<TType extends string, TData extends TSchema>(
  commandType: TType,
  data: TData,
): TObject<CommandProperties<TType, TData>> {
  return Type.Object(
    {
      commandId: UuidSchema,
      commandType: Type.Literal(commandType),
      schemaVersion: Type.Literal(1),
      actor: ActorSchema,
      requestId: UuidSchema,
      idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
      occurredAt: UtcTimestampSchema,
      locale: Type.String({ pattern: '^[a-z]{2}(?:-[A-Z]{2})?$', maxLength: 16 }),
      channelContext: Type.Optional(ChannelContextSchema),
      data,
    },
    { additionalProperties: false },
  );
}

export const BeginTelegramPhotoIngestionCommandSchema = commandSchema(
  'media.begin-telegram-photo-ingestion',
  Type.Object(
    {
      telegramFileId: Type.String({ minLength: 1, maxLength: 512 }),
      telegramFileUniqueId: Type.String({ minLength: 1, maxLength: 256 }),
      // Declarations are untrusted transport metadata. Oversized/unsupported declarations must
      // still reach the handler so the attempt is counted and safely rejected.
      declaredSizeBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      declaredMediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      originalFilename: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    },
    { additionalProperties: false },
  ),
);
export type BeginTelegramPhotoIngestionCommand = Static<
  typeof BeginTelegramPhotoIngestionCommandSchema
>;

export const BeginPhotoIngestionResultSchema = Type.Union([
  Type.Object(
    {
      assetId: UuidSchema,
      validationState: Type.Literal('pending'),
      acceptedAt: UtcTimestampSchema,
      replayed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      assetId: UuidSchema,
      validationState: Type.Literal('rejected'),
      errorCode: Type.Union([
        Type.Literal('media_too_large'),
        Type.Literal('unsupported_media_type'),
      ]),
      acceptedAt: UtcTimestampSchema,
      replayed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type BeginPhotoIngestionResult = Static<typeof BeginPhotoIngestionResultSchema>;

export const MediaValidationJobSchema = Type.Object(
  {
    jobId: UuidSchema,
    jobType: Type.Literal('media.validate.v1'),
    schemaVersion: Type.Literal(1),
    assetId: UuidSchema,
    validationVersion: Type.Integer({ minimum: 1 }),
    occurredAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export type MediaValidationJob = Static<typeof MediaValidationJobSchema>;

export const RecordValidatedPhotoCommandSchema = commandSchema(
  'media.record-validated-photo',
  Type.Object(
    {
      assetId: UuidSchema,
      detectedMediaType: detectedMediaTypeSchema,
      sizeBytes: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
      width: Type.Integer({ minimum: 600, maximum: 12_000 }),
      height: Type.Integer({ minimum: 600, maximum: 12_000 }),
      originalSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      normalizedSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      originalStorageKey: Type.String({ minLength: 1, maxLength: 1024 }),
      thumbnailStorageKey: Type.String({ minLength: 1, maxLength: 1024 }),
    },
    { additionalProperties: false },
  ),
);
export type RecordValidatedPhotoCommand = Static<typeof RecordValidatedPhotoCommandSchema>;

export const SetPrimaryPhotoCommandSchema = commandSchema(
  'media.set-primary-photo',
  Type.Object(
    { photoId: UuidSchema, expectedProfileVersion: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
);
export type SetPrimaryPhotoCommand = Static<typeof SetPrimaryPhotoCommandSchema>;

export const ReorderPhotosCommandSchema = commandSchema(
  'media.reorder-photos',
  Type.Object(
    {
      orderedPhotoIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 6, uniqueItems: true }),
      expectedProfileVersion: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type ReorderPhotosCommand = Static<typeof ReorderPhotosCommandSchema>;

export const DeletePhotoCommandSchema = commandSchema(
  'media.delete-photo',
  Type.Object(
    { photoId: UuidSchema, expectedProfileVersion: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
);
export type DeletePhotoCommand = Static<typeof DeletePhotoCommandSchema>;

export const ResolveMediaDeliveryGrantQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    photoId: UuidSchema,
    purpose: Type.Union([
      Type.Literal('profile_card'),
      Type.Literal('profile_detail'),
      Type.Literal('liked_by_blur'),
      Type.Literal('owner_preview'),
      Type.Literal('moderation_evidence'),
    ]),
    requestedVariant: PhotoVariantTypeSchema,
  },
  { additionalProperties: false },
);
export type ResolveMediaDeliveryGrantQuery = Static<typeof ResolveMediaDeliveryGrantQuerySchema>;

export const MediaDeliveryGrantSchema = Type.Object(
  {
    deliveryUrl: Type.String({ format: 'uri', pattern: '^https://' }),
    expiresAt: UtcTimestampSchema,
    variantType: PhotoVariantTypeSchema,
    cachePolicy: Type.Union([Type.Literal('private'), Type.Literal('no-store')]),
  },
  { additionalProperties: false },
);
export type MediaDeliveryGrant = Static<typeof MediaDeliveryGrantSchema>;
