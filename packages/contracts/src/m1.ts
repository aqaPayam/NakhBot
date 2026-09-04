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

export const AccountStateSchema = Type.Union([
  Type.Literal('guest'),
  Type.Literal('incomplete'),
  Type.Literal('active'),
  Type.Literal('restricted'),
  Type.Literal('banned'),
  Type.Literal('deleted'),
]);

export const ProfileCompletionStatusSchema = Type.Union([
  Type.Literal('incomplete'),
  Type.Literal('complete'),
  Type.Literal('invalid'),
]);

export const SignupStepSchema = Type.Union([
  Type.Literal('age_confirmation'),
  Type.Literal('name'),
  Type.Literal('birth_year'),
  Type.Literal('gender'),
  Type.Literal('relationship_gender_preference'),
  Type.Literal('interests'),
  Type.Literal('location'),
  Type.Literal('relationship_goal'),
  Type.Literal('primary_photo'),
  Type.Literal('additional_photos'),
  Type.Literal('highlight'),
  Type.Literal('optional_details'),
  Type.Literal('confirm_profile'),
  Type.Literal('completed'),
]);

export const CapabilitySchema = Type.Union([
  Type.Literal('guest_preview'),
  Type.Literal('start_signup'),
  Type.Literal('continue_signup'),
  Type.Literal('edit_profile'),
  Type.Literal('change_settings'),
  Type.Literal('start_discovery'),
  Type.Literal('view_existing_match'),
  Type.Literal('read_existing_chat'),
  Type.Literal('send_chat_message'),
  Type.Literal('unlock_existing_chat'),
  Type.Literal('start_paid_action'),
  Type.Literal('start_nakh'),
  Type.Literal('settle_pending_nakh'),
  Type.Literal('cancel_pending_nakh'),
  Type.Literal('act_on_delivered_nakh'),
  Type.Literal('create_support'),
  Type.Literal('delete_account'),
  Type.Literal('create_appeal'),
  Type.Literal('return_account'),
]);

export const EntryRouteSchema = Type.Union([
  Type.Literal('guest'),
  Type.Literal('continue_signup'),
  Type.Literal('main'),
  Type.Literal('main_discovery_paused'),
  Type.Literal('fix_profile'),
  Type.Literal('restricted'),
  Type.Literal('ban_appeal'),
  Type.Literal('return_decision'),
]);

export const CapabilityDenialReasonSchema = Type.Union([
  Type.Literal('account_state_denied'),
  Type.Literal('profile_incomplete'),
  Type.Literal('visibility_disabled'),
  Type.Literal('scope_missing'),
  Type.Literal('read_only'),
]);

const localeSchema = Type.String({ pattern: '^[a-z]{2}(?:-[A-Z]{2})?$', maxLength: 16 });
const stableCodeSchema = Type.String({ pattern: '^[a-z][a-z0-9_]*$', minLength: 1, maxLength: 80 });
const telegramUserIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

type CommandProperties<TType extends string, TData extends TSchema> = {
  commandId: typeof UuidSchema;
  commandType: TLiteral<TType>;
  schemaVersion: TLiteral<1>;
  actor: typeof ActorSchema;
  requestId: typeof UuidSchema;
  idempotencyKey: TString;
  occurredAt: typeof UtcTimestampSchema;
  locale: typeof localeSchema;
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
      locale: localeSchema,
      channelContext: Type.Optional(ChannelContextSchema),
      data,
    },
    { additionalProperties: false },
  );
}

export const AccessContextSchema = Type.Object(
  {
    accountState: AccountStateSchema,
    profileCompletion: Type.Union([ProfileCompletionStatusSchema, Type.Null()]),
    visibilityEnabled: Type.Boolean(),
    hasExistingMatch: Type.Optional(Type.Boolean()),
    hasExistingChat: Type.Optional(Type.Boolean()),
    hasExistingPendingNakh: Type.Optional(Type.Boolean()),
    hasDeliveredNakh: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const CapabilityDecisionSchema = Type.Object(
  {
    allowed: Type.Boolean(),
    reasonCode: Type.Optional(CapabilityDenialReasonSchema),
    requiredRoute: EntryRouteSchema,
  },
  { additionalProperties: false },
);

export const AccountContextSchema = Type.Object(
  {
    userId: UuidSchema,
    accountState: AccountStateSchema,
    profileCompletion: Type.Union([ProfileCompletionStatusSchema, Type.Null()]),
    visibilityEnabled: Type.Boolean(),
    uiLocale: localeSchema,
    guestPreviewCount: Type.Integer({ minimum: 0 }),
    guestPreviewLimit: Type.Integer({ minimum: 1 }),
    entryRoute: EntryRouteSchema,
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const RegisterTelegramIdentityCommandSchema = commandSchema(
  'identity.register-telegram-identity',
  Type.Object(
    {
      telegramUserId: telegramUserIdSchema,
      username: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
      updateId: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
  ),
);
export type RegisterTelegramIdentityCommand = Static<typeof RegisterTelegramIdentityCommandSchema>;

export const RegisterTelegramIdentityResultSchema = Type.Object(
  {
    context: AccountContextSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RegisterTelegramIdentityResult = Static<typeof RegisterTelegramIdentityResultSchema>;

export const RecordActivityCommandSchema = commandSchema(
  'identity.record-activity',
  Type.Object({}, { additionalProperties: false }),
);
export type RecordActivityCommand = Static<typeof RecordActivityCommandSchema>;

export const StartSignupCommandSchema = commandSchema(
  'identity.start-signup',
  Type.Object(
    { expectedAccountVersion: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
);
export type StartSignupCommand = Static<typeof StartSignupCommandSchema>;

const optionalDetailsSchema = Type.Object(
  {
    heightCm: Type.Optional(Type.Integer({ minimum: 100, maximum: 250 })),
    job: Type.Optional(Type.String({ maxLength: 64 })),
    educationLevelCode: Type.Optional(stableCodeSchema),
    smokingPreferenceCode: Type.Optional(stableCodeSchema),
    petsPreferenceCode: Type.Optional(stableCodeSchema),
    exerciseFrequencyCode: Type.Optional(stableCodeSchema),
    religionCode: Type.Optional(stableCodeSchema),
    childrenPreferenceCode: Type.Optional(stableCodeSchema),
    languageCodes: Type.Optional(Type.Array(stableCodeSchema, { maxItems: 10, uniqueItems: true })),
    personalityTagCodes: Type.Optional(
      Type.Array(stableCodeSchema, { maxItems: 5, uniqueItems: true }),
    ),
    bio: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const SignupStepValueSchema = Type.Union([
  Type.Object(
    { step: Type.Literal('age_confirmation'), accepted: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('name'), value: Type.String({ minLength: 1, maxLength: 128 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('birth_year'), value: Type.String({ minLength: 1, maxLength: 16 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('gender'), code: stableCodeSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('relationship_gender_preference'), code: stableCodeSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      step: Type.Literal('interests'),
      codes: Type.Array(stableCodeSchema, { minItems: 5, maxItems: 20, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      step: Type.Literal('location'),
      countryCode: stableCodeSchema,
      provinceCode: stableCodeSchema,
      cityCode: stableCodeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('relationship_goal'), code: stableCodeSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('primary_photo'), mediaAssetId: UuidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      step: Type.Literal('additional_photos'),
      mediaAssetIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('highlight'), value: Type.String({ minLength: 1, maxLength: 320 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('optional_details'), value: optionalDetailsSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { step: Type.Literal('confirm_profile'), confirmed: Type.Literal(true) },
    { additionalProperties: false },
  ),
]);

export const SaveSignupStepCommandSchema = commandSchema(
  'identity.save-signup-step',
  Type.Object(
    {
      expectedDraftVersion: Type.Integer({ minimum: 1 }),
      value: SignupStepValueSchema,
    },
    { additionalProperties: false },
  ),
);
export type SaveSignupStepCommand = Static<typeof SaveSignupStepCommandSchema>;

export const SignupStateSchema = Type.Object(
  {
    currentStep: SignupStepSchema,
    draftVersion: Type.Integer({ minimum: 1 }),
    updatedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export type SignupState = Static<typeof SignupStateSchema>;

export const ConfirmSignupCommandSchema = commandSchema(
  'identity.confirm-signup',
  Type.Object(
    { expectedDraftVersion: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
);
export type ConfirmSignupCommand = Static<typeof ConfirmSignupCommandSchema>;

export const ConsumeGuestPreviewCommandSchema = commandSchema(
  'identity.consume-guest-preview',
  Type.Object(
    {
      candidateUserId: UuidSchema,
      deliveryReceiptId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
);
export type ConsumeGuestPreviewCommand = Static<typeof ConsumeGuestPreviewCommandSchema>;

export const ChangeLocaleCommandSchema = commandSchema(
  'identity.change-locale',
  Type.Object({ locale: localeSchema }, { additionalProperties: false }),
);
export type ChangeLocaleCommand = Static<typeof ChangeLocaleCommandSchema>;

export const ChangeVisibilityCommandSchema = commandSchema(
  'identity.change-visibility',
  Type.Object(
    {
      visibilityEnabled: Type.Boolean(),
      expectedSettingsVersion: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type ChangeVisibilityCommand = Static<typeof ChangeVisibilityCommandSchema>;

const editableProfilePatchSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    relationshipGenderPreferenceCode: Type.Optional(stableCodeSchema),
    interestCodes: Type.Optional(
      Type.Array(stableCodeSchema, { minItems: 5, maxItems: 20, uniqueItems: true }),
    ),
    countryCode: Type.Optional(stableCodeSchema),
    provinceCode: Type.Optional(stableCodeSchema),
    cityCode: Type.Optional(stableCodeSchema),
    relationshipGoalCode: Type.Optional(stableCodeSchema),
    highlight: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
    optionalDetails: Type.Optional(optionalDetailsSchema),
  },
  { additionalProperties: false },
);

export const UpdateProfileCommandSchema = commandSchema(
  'profile.update',
  Type.Object(
    {
      expectedProfileVersion: Type.Integer({ minimum: 1 }),
      patch: editableProfilePatchSchema,
    },
    { additionalProperties: false },
  ),
);
export type UpdateProfileCommand = Static<typeof UpdateProfileCommandSchema>;

export const RequestProtectedProfileChangeCommandSchema = commandSchema(
  'profile.request-protected-change',
  Type.Union([
    Type.Object(
      {
        field: Type.Literal('birth_year'),
        requestedValue: Type.Integer(),
        reason: Type.String({ minLength: 1, maxLength: 4096 }),
        expectedProfileVersion: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        field: Type.Literal('gender'),
        requestedValue: stableCodeSchema,
        reason: Type.String({ minLength: 1, maxLength: 4096 }),
        expectedProfileVersion: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  ]),
);
export type RequestProtectedProfileChangeCommand = Static<
  typeof RequestProtectedProfileChangeCommandSchema
>;

export const ResolveProtectedProfileChangeCommandSchema = commandSchema(
  'profile.resolve-protected-change',
  Type.Object(
    {
      profileChangeRequestId: UuidSchema,
      decision: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
      note: Type.Optional(Type.String({ maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
);
export type ResolveProtectedProfileChangeCommand = Static<
  typeof ResolveProtectedProfileChangeCommandSchema
>;
