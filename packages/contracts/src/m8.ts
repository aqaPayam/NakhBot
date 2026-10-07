import { Type, type Static } from '@sinclair/typebox';
import { ChannelContextSchema, UtcTimestampSchema, UuidSchema } from './shared.js';

const actor = Type.Object(
  { userId: UuidSchema, kind: Type.Literal('user') },
  { additionalProperties: false },
);
const version = Type.Integer({ minimum: 1 });
const confirmation = Type.String({ minLength: 32, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' });
const pendingDeletionPhaseSchema = Type.Union([
  Type.Literal('shared_closure'),
  Type.Literal('evidence_capture'),
  Type.Literal('product_data'),
  Type.Literal('media_objects'),
  Type.Literal('ephemeral_access'),
  Type.Literal('retention_manifest'),
  Type.Literal('verification'),
]);
export const AccountDeletionPhaseSchema = Type.Union([
  pendingDeletionPhaseSchema,
  Type.Literal('completed'),
]);

export const PrepareAccountDeletionQuerySchema = Type.Object(
  {
    actor,
    requestId: UuidSchema,
    expectedAccountVersion: version,
  },
  { additionalProperties: false },
);
export type PrepareAccountDeletionQuery = Static<typeof PrepareAccountDeletionQuerySchema>;
export const PreparedAccountDeletionSchema = Type.Object(
  {
    confirmationToken: confirmation,
    expiresAt: UtcTimestampSchema,
    expectedAccountVersion: version,
  },
  { additionalProperties: false },
);
export type PreparedAccountDeletion = Static<typeof PreparedAccountDeletionSchema>;

export const RequestAccountDeletionCommandSchema = Type.Object(
  {
    commandId: UuidSchema,
    commandType: Type.Literal('account.delete'),
    schemaVersion: Type.Literal(1),
    actor,
    requestId: UuidSchema,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
    occurredAt: UtcTimestampSchema,
    locale: Type.String({ pattern: '^[a-z]{2}(?:-[A-Z]{2})?$', maxLength: 16 }),
    channelContext: Type.Optional(ChannelContextSchema),
    data: Type.Object(
      { confirmationToken: confirmation, expectedAccountVersion: version },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type RequestAccountDeletionCommand = Static<typeof RequestAccountDeletionCommandSchema>;

export const CancelAccountDeletionCommandSchema = Type.Object(
  {
    ...RequestAccountDeletionCommandSchema.properties,
    commandType: Type.Literal('account.cancel-deletion'),
  },
  { additionalProperties: false },
);
export type CancelAccountDeletionCommand = Static<typeof CancelAccountDeletionCommandSchema>;
export const CancelAccountDeletionResultSchema = Type.Object(
  { cancelled: Type.Literal(true), replayed: Type.Boolean() },
  { additionalProperties: false },
);
export type CancelAccountDeletionResult = Static<typeof CancelAccountDeletionResultSchema>;

/** Own lifecycle only: no user selector, retained evidence, provider keys or private manifest rows. */
export const GetAccountDeletionStatusQuerySchema = Type.Object(
  { actor, requestId: UuidSchema },
  { additionalProperties: false },
);
export type GetAccountDeletionStatusQuery = Static<typeof GetAccountDeletionStatusQuerySchema>;
export const AccountDeletionStatusSchema = Type.Union([
  Type.Object(
    {
      phase: pendingDeletionPhaseSchema,
      requestedAt: UtcTimestampSchema,
      completedAt: Type.Null(),
      returnDecision: Type.Literal('purge_pending'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      phase: Type.Literal('completed'),
      requestedAt: UtcTimestampSchema,
      completedAt: UtcTimestampSchema,
      returnDecision: Type.Union([
        Type.Literal('reactivation_denied'),
        Type.Literal('safety_bar'),
        Type.Literal('allowed'),
      ]),
    },
    { additionalProperties: false },
  ),
]);
export type AccountDeletionStatus = Static<typeof AccountDeletionStatusSchema>;
export const RequestAccountDeletionResultSchema = Type.Object(
  { status: AccountDeletionStatusSchema, accountVersion: version, replayed: Type.Boolean() },
  { additionalProperties: false },
);
export type RequestAccountDeletionResult = Static<typeof RequestAccountDeletionResultSchema>;
