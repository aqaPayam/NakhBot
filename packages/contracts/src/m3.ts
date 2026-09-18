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

export const ExploreConsumptionReasonSchema = Type.Union([
  Type.Literal('preview'),
  Type.Literal('like'),
  Type.Literal('not_interested'),
  Type.Literal('nakh_flow'),
  Type.Literal('match'),
]);

export const M3EventTypeSchema = Type.Union([
  Type.Literal('discovery.filter-saved.v1'),
  Type.Literal('discovery.candidate-reserved.v1'),
  Type.Literal('discovery.candidate-delivered.v1'),
  Type.Literal('discovery.candidate-delivery-failed.v1'),
  Type.Literal('discovery.consumption-created.v1'),
  Type.Literal('interaction.like-created.v1'),
  Type.Literal('interaction.like-closed.v1'),
  Type.Literal('interaction.not-interested-created.v1'),
  Type.Literal('matching.match-created.v1'),
]);
export type M3EventType = Static<typeof M3EventTypeSchema>;

export const SaveExploreFilterCommandSchema = commandSchema(
  'discovery.save-explore-filter',
  Type.Object(
    {
      targetGenderOptionIds: Type.Array(UuidSchema, {
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
      }),
      minAge: Type.Integer({ minimum: 18, maximum: 120 }),
      maxAge: Type.Integer({ minimum: 18, maximum: 120 }),
      cityId: UuidSchema,
      relationshipGoalCode: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' })),
      expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
);
export type SaveExploreFilterCommand = Static<typeof SaveExploreFilterCommandSchema>;

export const GetNextExploreCandidateQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    mode: Type.Union([Type.Literal('explore'), Type.Literal('guest_preview')]),
    filterVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type GetNextExploreCandidateQuery = Static<typeof GetNextExploreCandidateQuerySchema>;

export const SendLikeCommandSchema = commandSchema(
  'interaction.send-like',
  Type.Object({ targetUserId: UuidSchema }, { additionalProperties: false }),
);
export type SendLikeCommand = Static<typeof SendLikeCommandSchema>;

export const MarkNotInterestedCommandSchema = commandSchema(
  'interaction.mark-not-interested',
  Type.Object(
    {
      targetUserId: UuidSchema,
      source: Type.Union([
        Type.Literal('explore'),
        Type.Literal('liked_by'),
        Type.Literal('cancelled_pending_nakh'),
      ]),
    },
    { additionalProperties: false },
  ),
);
export type MarkNotInterestedCommand = Static<typeof MarkNotInterestedCommandSchema>;

const LikedByOpaqueReferenceSchema = Type.String({
  pattern: '^v1\\.lb\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{16}$',
  maxLength: 64,
});

export const GetLikedByPageQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    cursor: Type.Optional(LikedByOpaqueReferenceSchema),
  },
  { additionalProperties: false },
);
export type GetLikedByPageQuery = Static<typeof GetLikedByPageQuerySchema>;

const LikedByBlurGrantSchema = Type.Object(
  {
    deliveryUrl: Type.String({ format: 'uri', pattern: '^https://' }),
    expiresAt: UtcTimestampSchema,
    variantType: Type.Literal('blurred_preview'),
    cachePolicy: Type.Literal('no-store'),
  },
  { additionalProperties: false },
);

export const LockedLikedByPageSchema = Type.Object(
  {
    totalCount: Type.Integer({ minimum: 0 }),
    cards: Type.Array(
      Type.Object(
        {
          actionToken: LikedByOpaqueReferenceSchema,
          blurredPhoto: LikedByBlurGrantSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    nextCursor: Type.Optional(LikedByOpaqueReferenceSchema),
  },
  { additionalProperties: false },
);
export type LockedLikedByPage = Static<typeof LockedLikedByPageSchema>;

export const CandidateDeliveryJobSchema = Type.Object(
  {
    jobId: UuidSchema,
    jobType: Type.Literal('discovery.deliver-candidate.v1'),
    schemaVersion: Type.Literal(1),
    deliveryId: UuidSchema,
    occurredAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export type CandidateDeliveryJob = Static<typeof CandidateDeliveryJobSchema>;

export const InteractionResultSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal('liked'), Type.Literal('matched'), Type.Literal('rejected')]),
    interactionId: UuidSchema,
    matchId: Type.Optional(UuidSchema),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InteractionResult = Static<typeof InteractionResultSchema>;
