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

export const NakhTextSchema = Type.String({ minLength: 1, maxLength: 240 });
export const PendingNakhStatusSchema = Type.Union([
  Type.Literal('pending_payment'),
  Type.Literal('paid_and_sent'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
  Type.Literal('closed_by_system'),
]);
export type PendingNakhStatus = Static<typeof PendingNakhStatusSchema>;

export const PendingNakhCancelResolutionSchema = Type.Union([
  Type.Literal('converted_to_like'),
  Type.Literal('converted_to_not_interested'),
]);
export type PendingNakhCancelResolution = Static<typeof PendingNakhCancelResolutionSchema>;

export const NakhStatusSchema = Type.Union([
  Type.Literal('sent'),
  Type.Literal('seen'),
  Type.Literal('accepted'),
  Type.Literal('rejected'),
  Type.Literal('expired'),
  Type.Literal('closed'),
]);
export type NakhStatus = Static<typeof NakhStatusSchema>;

export const NakhReceiverActionTypeSchema = Type.Union([
  Type.Literal('view_profile'),
  Type.Literal('accept'),
  Type.Literal('reject'),
  Type.Literal('report'),
]);
export type NakhReceiverActionType = Static<typeof NakhReceiverActionTypeSchema>;

export const M5EventTypeSchema = Type.Union([
  Type.Literal('nakh.flow-created.v1'),
  Type.Literal('nakh.pending-created.v1'),
  Type.Literal('nakh.pending-updated.v1'),
  Type.Literal('nakh.pending-reminder-requested.v1'),
  Type.Literal('nakh.delivered.v1'),
  Type.Literal('nakh.cancelled.v1'),
  Type.Literal('nakh.status-changed.v1'),
  Type.Literal('nakh.settlement-requested.v1'),
  Type.Literal('matching.match-created.v1'),
]);
export type M5EventType = Static<typeof M5EventTypeSchema>;

export const CreateDirectNakhCommandSchema = commandSchema(
  'nakh.create-direct',
  Type.Object({ targetUserId: UuidSchema, text: NakhTextSchema }, { additionalProperties: false }),
);
export type CreateDirectNakhCommand = Static<typeof CreateDirectNakhCommandSchema>;

export const CreatePendingNakhCommandSchema = commandSchema(
  'nakh.create-pending',
  Type.Object(
    {
      targetUserId: UuidSchema,
      text: NakhTextSchema,
      autoSettleAuthorized: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
);
export type CreatePendingNakhCommand = Static<typeof CreatePendingNakhCommandSchema>;

export const EditPendingNakhCommandSchema = commandSchema(
  'nakh.edit-pending',
  Type.Object(
    {
      pendingNakhId: UuidSchema,
      text: NakhTextSchema,
      expectedVersion: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type EditPendingNakhCommand = Static<typeof EditPendingNakhCommandSchema>;

export const CancelPendingNakhCommandSchema = commandSchema(
  'nakh.cancel-pending',
  Type.Object(
    {
      pendingNakhId: UuidSchema,
      resolution: PendingNakhCancelResolutionSchema,
      expectedVersion: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type CancelPendingNakhCommand = Static<typeof CancelPendingNakhCommandSchema>;

export const SettlePendingNakhesCommandSchema = commandSchema(
  'nakh.settle-pending',
  Type.Object(
    { senderUserId: UuidSchema, triggerCreditTransactionId: UuidSchema },
    { additionalProperties: false },
  ),
);
export type SettlePendingNakhesCommand = Static<typeof SettlePendingNakhesCommandSchema>;

const DeliveredNakhActionDataSchema = Type.Object(
  { nakhId: UuidSchema, expectedVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const ViewNakhProfileCommandSchema = commandSchema(
  'nakh.view-profile',
  DeliveredNakhActionDataSchema,
);
export type ViewNakhProfileCommand = Static<typeof ViewNakhProfileCommandSchema>;
export const AcceptNakhCommandSchema = commandSchema('nakh.accept', DeliveredNakhActionDataSchema);
export type AcceptNakhCommand = Static<typeof AcceptNakhCommandSchema>;
export const RejectNakhCommandSchema = commandSchema('nakh.reject', DeliveredNakhActionDataSchema);
export type RejectNakhCommand = Static<typeof RejectNakhCommandSchema>;

export const SendPendingNakhReminderCommandSchema = commandSchema(
  'nakh.send-pending-reminder',
  Type.Object({ pendingNakhId: UuidSchema }, { additionalProperties: false }),
);
export type SendPendingNakhReminderCommand = Static<typeof SendPendingNakhReminderCommandSchema>;

export const ExpirePendingNakhCommandSchema = commandSchema(
  'nakh.expire-pending',
  Type.Object({ pendingNakhId: UuidSchema }, { additionalProperties: false }),
);
export type ExpirePendingNakhCommand = Static<typeof ExpirePendingNakhCommandSchema>;

export const ExpireDeliveredNakhCommandSchema = commandSchema(
  'nakh.expire-delivered',
  Type.Object({ nakhId: UuidSchema }, { additionalProperties: false }),
);
export type ExpireDeliveredNakhCommand = Static<typeof ExpireDeliveredNakhCommandSchema>;

const PendingNakhCursorSchema = Type.String({
  pattern: '^v1\\.pn\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const NakhCursorSchema = Type.String({
  pattern: '^v1\\.nk\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});

export const GetPendingNakhPageQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    cursor: Type.Optional(PendingNakhCursorSchema),
  },
  { additionalProperties: false },
);
export type GetPendingNakhPageQuery = Static<typeof GetPendingNakhPageQuerySchema>;
export const GetSentNakhStatusPageQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    cursor: Type.Optional(NakhCursorSchema),
  },
  { additionalProperties: false },
);
export type GetSentNakhStatusPageQuery = Static<typeof GetSentNakhStatusPageQuerySchema>;
export const GetReceivedNakhPageQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    cursor: Type.Optional(NakhCursorSchema),
  },
  { additionalProperties: false },
);
export type GetReceivedNakhPageQuery = Static<typeof GetReceivedNakhPageQuerySchema>;

export const GetNakhDetailQuerySchema = Type.Object(
  { actor: ActorSchema, requestId: UuidSchema, nakhId: UuidSchema },
  { additionalProperties: false },
);
export type GetNakhDetailQuery = Static<typeof GetNakhDetailQuerySchema>;

export const DirectNakhResultSchema = Type.Object(
  {
    nakhId: UuidSchema,
    status: Type.Literal('sent'),
    sentAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type DirectNakhResult = Static<typeof DirectNakhResultSchema>;

export const PendingNakhResultSchema = Type.Object(
  {
    pendingNakhId: UuidSchema,
    status: PendingNakhStatusSchema,
    expiresAt: UtcTimestampSchema,
    version: Type.Integer({ minimum: 1 }),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PendingNakhResult = Static<typeof PendingNakhResultSchema>;

export const NakhActionResultSchema = Type.Object(
  {
    nakhId: UuidSchema,
    status: NakhStatusSchema,
    matchId: Type.Optional(UuidSchema),
    changedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type NakhActionResult = Static<typeof NakhActionResultSchema>;
