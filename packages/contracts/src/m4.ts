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

export const CreditAmountSchema = Type.String({ pattern: '^(?:0|[1-9][0-9]{0,18})$' });
export const PositiveCreditAmountSchema = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
export const CreditPackageCodeSchema = Type.Union([
  Type.Literal('starter'),
  Type.Literal('plus'),
  Type.Literal('best_value'),
  Type.Literal('ultimate'),
]);
export type CreditPackageCode = Static<typeof CreditPackageCodeSchema>;

export const PaidActionReasonSchema = Type.Union([
  Type.Literal('unlock_liked_by_profile'),
  Type.Literal('unlock_chat'),
]);
export type PaidActionReason = Static<typeof PaidActionReasonSchema>;

export const FeatureUnlockTypeSchema = Type.Union([
  Type.Literal('liked_by_profile_unlock'),
  Type.Literal('chat_unlock'),
]);
export type FeatureUnlockType = Static<typeof FeatureUnlockTypeSchema>;

export const M4EventTypeSchema = Type.Union([
  Type.Literal('billing.payment-receipt-recorded.v1'),
  Type.Literal('billing.payment-fulfilled.v1'),
  Type.Literal('billing.payment-correction-required.v1'),
  Type.Literal('billing.credit-increased.v1'),
  Type.Literal('entitlement.feature-unlocked.v1'),
  Type.Literal('notification.delivery-requested.v1'),
]);
export type M4EventType = Static<typeof M4EventTypeSchema>;

const OpaquePaidActionTokenSchema = Type.String({
  pattern: '^v1\\.pa\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});

const PackageFundingTargetSchema = Type.Object(
  { type: Type.Literal('credit_package'), packageCode: CreditPackageCodeSchema },
  { additionalProperties: false },
);
const LikedByFundingTargetSchema = Type.Object(
  { type: Type.Literal('liked_by_profile_unlock'), actionToken: OpaquePaidActionTokenSchema },
  { additionalProperties: false },
);
const ChatFundingTargetSchema = Type.Object(
  { type: Type.Literal('chat_unlock'), actionToken: OpaquePaidActionTokenSchema },
  { additionalProperties: false },
);

export const CreateFundingIntentCommandSchema = commandSchema(
  'billing.create-funding-intent',
  Type.Union([
    Type.Object(
      { funding: Type.Literal('stars'), target: PackageFundingTargetSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        funding: Type.Union([Type.Literal('credits'), Type.Literal('stars')]),
        target: Type.Union([LikedByFundingTargetSchema, ChatFundingTargetSchema]),
      },
      { additionalProperties: false },
    ),
  ]),
);
export type CreateFundingIntentCommand = Static<typeof CreateFundingIntentCommandSchema>;

export const SpendCreditsForActionCommandSchema = commandSchema(
  'billing.spend-credits-for-action',
  Type.Object(
    { target: Type.Union([LikedByFundingTargetSchema, ChatFundingTargetSchema]) },
    { additionalProperties: false },
  ),
);
export type SpendCreditsForActionCommand = Static<typeof SpendCreditsForActionCommandSchema>;

export const CreateStarsInvoiceCommandSchema = commandSchema(
  'billing.create-stars-invoice',
  Type.Object(
    { fundingIntentId: UuidSchema, expectedVersion: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
);
export type CreateStarsInvoiceCommand = Static<typeof CreateStarsInvoiceCommandSchema>;

export const CreditBalanceSchema = Type.Object(
  { balance: CreditAmountSchema, version: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type CreditBalance = Static<typeof CreditBalanceSchema>;

export const FundingIntentResultSchema = Type.Object(
  {
    fundingIntentId: UuidSchema,
    funding: Type.Union([Type.Literal('credits'), Type.Literal('stars')]),
    requiredAmount: PositiveCreditAmountSchema,
    status: Type.Literal('pending'),
    expiresAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type FundingIntentResult = Static<typeof FundingIntentResultSchema>;

export const StarsInvoiceResultSchema = Type.Object(
  {
    paymentRecordId: UuidSchema,
    currency: Type.Literal('XTR'),
    starsAmount: PositiveCreditAmountSchema,
    invoiceUrl: Type.String({ format: 'uri' }),
    status: Type.Literal('pending'),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type StarsInvoiceResult = Static<typeof StarsInvoiceResultSchema>;

export const FeatureUnlockResultSchema = Type.Object(
  {
    featureUnlockId: UuidSchema,
    featureType: FeatureUnlockTypeSchema,
    status: Type.Literal('active'),
    unlockedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type FeatureUnlockResult = Static<typeof FeatureUnlockResultSchema>;
