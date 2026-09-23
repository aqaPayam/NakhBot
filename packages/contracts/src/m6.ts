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

export const ChatMessageTypeSchema = Type.Union([
  Type.Literal('predefined_question'),
  Type.Literal('predefined_answer'),
  Type.Literal('text'),
  Type.Literal('system'),
]);
export type ChatMessageType = Static<typeof ChatMessageTypeSchema>;

export const ChatTextSchema = Type.String({ minLength: 1, maxLength: 1000 });
export const ChatSequenceSchema = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const FenceTokenSchema = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const ChatActionTokenSchema = Type.String({
  pattern: '^v1\\.ch\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const MatchActionTokenSchema = Type.String({
  pattern: '^v1\\.mt\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const ChatCursorSchema = Type.String({
  pattern: '^v1\\.cm\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const SafeCodeSchema = Type.String({ pattern: '^[a-z][a-z0-9_]{0,79}$' });

export const M6EventTypeSchema = Type.Union([
  Type.Literal('chat.message-created.v1'),
  Type.Literal('chat.read-advanced.v1'),
  Type.Literal('chat.mute-changed.v1'),
  Type.Literal('chat.closed.v1'),
  Type.Literal('chat.cleanup-requested.v1'),
  Type.Literal('chat.messages-cleaned.v1'),
  Type.Literal('matching.unmatched.v1'),
  Type.Literal('notification.delivery-attempted.v1'),
  Type.Literal('notification.delivery-settled.v1'),
]);
export type M6EventType = Static<typeof M6EventTypeSchema>;

export const OpenChatForMatchCommandSchema = commandSchema(
  'chat.open-for-match',
  Type.Object({ matchActionToken: MatchActionTokenSchema }, { additionalProperties: false }),
);
export type OpenChatForMatchCommand = Static<typeof OpenChatForMatchCommandSchema>;

export const SendPredefinedQuestionCommandSchema = commandSchema(
  'chat.send-predefined-question',
  Type.Object(
    { chatActionToken: ChatActionTokenSchema, questionId: UuidSchema },
    { additionalProperties: false },
  ),
);
export type SendPredefinedQuestionCommand = Static<typeof SendPredefinedQuestionCommandSchema>;

export const SendPredefinedAnswerCommandSchema = commandSchema(
  'chat.send-predefined-answer',
  Type.Object(
    {
      chatActionToken: ChatActionTokenSchema,
      questionId: UuidSchema,
      answerId: UuidSchema,
    },
    { additionalProperties: false },
  ),
);
export type SendPredefinedAnswerCommand = Static<typeof SendPredefinedAnswerCommandSchema>;

export const SendTextMessageCommandSchema = commandSchema(
  'chat.send-text',
  Type.Object(
    { chatActionToken: ChatActionTokenSchema, text: ChatTextSchema },
    { additionalProperties: false },
  ),
);
export type SendTextMessageCommand = Static<typeof SendTextMessageCommandSchema>;

export const MarkChatReadCommandSchema = commandSchema(
  'chat.mark-read',
  Type.Object(
    { chatActionToken: ChatActionTokenSchema, throughSequenceNumber: ChatSequenceSchema },
    { additionalProperties: false },
  ),
);
export type MarkChatReadCommand = Static<typeof MarkChatReadCommandSchema>;

export const ChangeChatMuteCommandSchema = commandSchema(
  'chat.change-mute',
  Type.Object(
    {
      chatActionToken: ChatActionTokenSchema,
      muted: Type.Boolean(),
      expectedVersion: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type ChangeChatMuteCommand = Static<typeof ChangeChatMuteCommandSchema>;

export const UnmatchCommandSchema = commandSchema(
  'matching.unmatch',
  Type.Object(
    { matchActionToken: MatchActionTokenSchema, reasonCode: Type.Optional(SafeCodeSchema) },
    { additionalProperties: false },
  ),
);
export type UnmatchCommand = Static<typeof UnmatchCommandSchema>;

export const CaptureReportedMessagesCommandSchema = commandSchema(
  'chat.capture-reported-messages',
  Type.Object(
    {
      reportId: UuidSchema,
      chatSessionId: UuidSchema,
      messageIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
);
export type CaptureReportedMessagesCommand = Static<typeof CaptureReportedMessagesCommandSchema>;

export const CleanupChatCommandSchema = commandSchema(
  'chat.cleanup',
  Type.Object(
    { chatSessionId: UuidSchema, deleteBatchSize: Type.Integer({ minimum: 1, maximum: 500 }) },
    { additionalProperties: false },
  ),
);
export type CleanupChatCommand = Static<typeof CleanupChatCommandSchema>;

export const ClaimNotificationDeliveriesCommandSchema = commandSchema(
  'notification.claim-deliveries',
  Type.Object(
    {
      workerId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
      limit: Type.Integer({ minimum: 1, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
);
export type ClaimNotificationDeliveriesCommand = Static<
  typeof ClaimNotificationDeliveriesCommandSchema
>;

const NotificationDeliverySettlementSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal('sent'),
      providerMessageKey: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal('failed_retryable'),
      failureCode: SafeCodeSchema,
      retryAfterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 900_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { outcome: Type.Literal('failed_terminal'), failureCode: SafeCodeSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { outcome: Type.Literal('ambiguous'), failureCode: Type.Literal('ambiguous_result') },
    { additionalProperties: false },
  ),
]);

export const SettleNotificationDeliveryCommandSchema = commandSchema(
  'notification.settle-delivery',
  Type.Object(
    {
      deliveryId: UuidSchema,
      leaseOwner: Type.String({ minLength: 1, maxLength: 128 }),
      fenceToken: FenceTokenSchema,
      result: NotificationDeliverySettlementSchema,
    },
    { additionalProperties: false },
  ),
);
export type SettleNotificationDeliveryCommand = Static<
  typeof SettleNotificationDeliveryCommandSchema
>;

export const GetChatCapabilityQuerySchema = Type.Object(
  { actor: ActorSchema, requestId: UuidSchema, chatActionToken: ChatActionTokenSchema },
  { additionalProperties: false },
);
export type GetChatCapabilityQuery = Static<typeof GetChatCapabilityQuerySchema>;

export const GetChatPageQuerySchema = Type.Object(
  {
    actor: ActorSchema,
    requestId: UuidSchema,
    chatActionToken: ChatActionTokenSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    cursor: Type.Optional(ChatCursorSchema),
  },
  { additionalProperties: false },
);
export type GetChatPageQuery = Static<typeof GetChatPageQuerySchema>;

export const ChatCapabilitySchema = Type.Object(
  {
    chatActionToken: ChatActionTokenSchema,
    chatSessionId: UuidSchema,
    matchId: UuidSchema,
    status: Type.Union([Type.Literal('active'), Type.Literal('closed')]),
    canRead: Type.Boolean(),
    canSendPredefined: Type.Boolean(),
    canSendText: Type.Boolean(),
    canUnmatch: Type.Boolean(),
    textUnlocked: Type.Boolean(),
    mustShowSafetyWarning: Type.Boolean(),
    muted: Type.Boolean(),
    lastReadSequenceNumber: Type.Optional(ChatSequenceSchema),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ChatCapability = Static<typeof ChatCapabilitySchema>;

const ChatMessageBaseProperties = {
  messageId: UuidSchema,
  sequenceNumber: ChatSequenceSchema,
  sender: Type.Union([Type.Literal('self'), Type.Literal('match'), Type.Literal('system')]),
  createdAt: UtcTimestampSchema,
};

export const ChatMessageSchema = Type.Union([
  Type.Object(
    {
      ...ChatMessageBaseProperties,
      messageType: Type.Literal('predefined_question'),
      content: Type.Object(
        { questionId: UuidSchema, textKey: Type.String({ minLength: 1, maxLength: 160 }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ChatMessageBaseProperties,
      messageType: Type.Literal('predefined_answer'),
      content: Type.Object(
        {
          questionId: UuidSchema,
          answerId: UuidSchema,
          textKey: Type.String({ minLength: 1, maxLength: 160 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ChatMessageBaseProperties,
      messageType: Type.Literal('text'),
      content: Type.Object({ text: ChatTextSchema }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ChatMessageBaseProperties,
      sender: Type.Literal('system'),
      messageType: Type.Literal('system'),
      content: Type.Object(
        {
          textKey: Type.String({ minLength: 1, maxLength: 160 }),
          arguments: Type.Record(
            Type.String({ pattern: '^[a-z][a-zA-Z0-9]{0,39}$' }),
            Type.String({ maxLength: 160 }),
            { maxProperties: 10 },
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type ChatMessage = Static<typeof ChatMessageSchema>;

export const ChatMessageResultSchema = Type.Object(
  { message: ChatMessageSchema, replayed: Type.Boolean() },
  { additionalProperties: false },
);
export type ChatMessageResult = Static<typeof ChatMessageResultSchema>;

export const ChatPageSchema = Type.Object(
  {
    items: Type.Array(ChatMessageSchema, { maxItems: 50 }),
    nextCursor: Type.Optional(ChatCursorSchema),
  },
  { additionalProperties: false },
);
export type ChatPage = Static<typeof ChatPageSchema>;

export const ChatReadResultSchema = Type.Object(
  {
    throughSequenceNumber: ChatSequenceSchema,
    readAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ChatReadResult = Static<typeof ChatReadResultSchema>;

export const ChatMuteResultSchema = Type.Object(
  {
    muted: Type.Boolean(),
    changedAt: UtcTimestampSchema,
    version: Type.Integer({ minimum: 1 }),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ChatMuteResult = Static<typeof ChatMuteResultSchema>;

export const UnmatchResultSchema = Type.Object(
  {
    matchId: UuidSchema,
    status: Type.Literal('unmatched'),
    unmatchedAt: UtcTimestampSchema,
    reportWindowExpiresAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type UnmatchResult = Static<typeof UnmatchResultSchema>;

export const ClaimedNotificationDeliverySchema = Type.Object(
  {
    deliveryId: UuidSchema,
    notificationId: UuidSchema,
    fenceToken: FenceTokenSchema,
    leaseExpiresAt: UtcTimestampSchema,
    attemptNumber: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ClaimedNotificationDelivery = Static<typeof ClaimedNotificationDeliverySchema>;
