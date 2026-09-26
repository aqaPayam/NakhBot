import { Type, type Static } from '@sinclair/typebox';

import { ActorSchema, ChannelContextSchema, UtcTimestampSchema, UuidSchema } from './shared.js';

export * from './m1.js';
export * from './m2.js';
export * from './m3.js';
export * from './m4.js';
export * from './m5.js';
export * from './m6.js';
export * from './m7.js';
export * from './shared.js';

export const CreateSampleEffectDataSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
  },
  { additionalProperties: false },
);

export const CreateSampleEffectCommandSchema = Type.Object(
  {
    commandId: UuidSchema,
    commandType: Type.Literal('platform.create-sample-effect'),
    schemaVersion: Type.Literal(1),
    actor: ActorSchema,
    requestId: UuidSchema,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
    occurredAt: UtcTimestampSchema,
    locale: Type.String({ pattern: '^[a-z]{2}(?:-[A-Z]{2})?$', maxLength: 16 }),
    channelContext: Type.Optional(ChannelContextSchema),
    data: CreateSampleEffectDataSchema,
  },
  { additionalProperties: false },
);

export type CreateSampleEffectCommand = Static<typeof CreateSampleEffectCommandSchema>;

export const CreateSampleEffectResultSchema = Type.Object(
  {
    effectId: UuidSchema,
    eventId: UuidSchema,
    name: Type.String(),
    createdAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type CreateSampleEffectResult = Static<typeof CreateSampleEffectResultSchema>;

export const DomainEventSchema = Type.Object(
  {
    id: UuidSchema,
    eventType: Type.String({ minLength: 1, maxLength: 160 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    aggregateType: Type.String({ minLength: 1, maxLength: 80 }),
    aggregateId: UuidSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
    occurredAt: UtcTimestampSchema,
    correlationId: UuidSchema,
    causationId: UuidSchema,
  },
  { additionalProperties: false },
);

export type DomainEvent = Static<typeof DomainEventSchema>;

export type ProblemDetails = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  detail?: string;
  errors?: ReadonlyArray<Readonly<{ path: string; code: string }>>;
}>;
