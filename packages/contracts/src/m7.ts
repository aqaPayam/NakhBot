import {
  Type,
  type Static,
  type TLiteral,
  type TObject,
  type TOptional,
  type TSchema,
  type TString,
} from '@sinclair/typebox';

import { ChannelContextSchema, UtcTimestampSchema, UuidSchema } from './shared.js';

const UserActorSchema = Type.Object(
  { userId: UuidSchema, kind: Type.Literal('user') },
  { additionalProperties: false },
);
const AdminActorSchema = Type.Object(
  { userId: UuidSchema, kind: Type.Literal('admin') },
  { additionalProperties: false },
);
const SystemActorSchema = Type.Object(
  { userId: UuidSchema, kind: Type.Literal('system') },
  { additionalProperties: false },
);

type MutationProperties<TType extends string, TActor extends TSchema, TData extends TSchema> = {
  commandId: typeof UuidSchema;
  commandType: TLiteral<TType>;
  schemaVersion: TLiteral<1>;
  actor: TActor;
  requestId: typeof UuidSchema;
  idempotencyKey: TString;
  occurredAt: typeof UtcTimestampSchema;
  locale: TString;
  channelContext: TOptional<typeof ChannelContextSchema>;
  data: TData;
};

function mutationSchema<TType extends string, TActor extends TSchema, TData extends TSchema>(
  commandType: TType,
  actor: TActor,
  data: TData,
): TObject<MutationProperties<TType, TActor, TData>> {
  return Type.Object(
    {
      commandId: UuidSchema,
      commandType: Type.Literal(commandType),
      schemaVersion: Type.Literal(1),
      actor,
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

const SafeCodeSchema = Type.String({ pattern: '^[a-z][a-z0-9_]{0,79}$' });
const ReportTextSchema = Type.String({ minLength: 1, maxLength: 1024 });
const AdminReasonSchema = Type.String({ minLength: 1, maxLength: 1024 });
const RestrictedLongTextSchema = Type.String({ minLength: 1, maxLength: 2000 });
const ReviewNoteSchema = Type.String({ minLength: 1, maxLength: 2000 });
const EvidenceSourceTokenSchema = Type.String({
  pattern: '^v1\\.rs\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const EvidenceIntentTokenSchema = Type.String({
  pattern: '^v1\\.ri\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const AdminActionTokenSchema = Type.String({
  pattern: '^v1\\.ad\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const ConfirmationTokenSchema = Type.String({
  pattern: '^v1\\.cf\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const SupportActionTokenSchema = Type.String({
  pattern: '^v1\\.sp\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const BanActionTokenSchema = Type.String({
  pattern: '^v1\\.bn\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});
const PageCursorSchema = Type.String({
  pattern: '^v1\\.m7\\.[A-Za-z0-9_-]{16,128}\\.[A-Za-z0-9_-]{16,128}$',
  maxLength: 320,
});

export const ReportEvidenceTypeSchema = Type.Union([
  Type.Literal('profile'),
  Type.Literal('photo'),
  Type.Literal('chat'),
  Type.Literal('message'),
  Type.Literal('unmatched_user'),
]);
export type ReportEvidenceType = Static<typeof ReportEvidenceTypeSchema>;

export const ReportStatusSchema = Type.Union([
  Type.Literal('submitted'),
  Type.Literal('pending_review'),
  Type.Literal('dismissed'),
  Type.Literal('actioned'),
  Type.Literal('closed'),
]);
export type ReportStatus = Static<typeof ReportStatusSchema>;

export const ModerationReviewStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_review'),
  Type.Literal('dismissed'),
  Type.Literal('actioned'),
]);
export type ModerationReviewStatus = Static<typeof ModerationReviewStatusSchema>;

export const M7PermissionSchema = Type.Union([
  Type.Literal('view_reports'),
  Type.Literal('assign_reports'),
  Type.Literal('review_reports'),
  Type.Literal('restrict_users'),
  Type.Literal('ban_users'),
  Type.Literal('moderate_photos'),
  Type.Literal('manage_internal_blocks'),
  Type.Literal('review_support'),
  Type.Literal('review_appeals'),
  Type.Literal('manage_admins'),
  Type.Literal('run_reconciliation'),
  Type.Literal('view_operational_health'),
]);
export type M7Permission = Static<typeof M7PermissionSchema>;

export const AccountModerationActionSchema = Type.Union([
  Type.Literal('restrict_user'),
  Type.Literal('unrestrict_user'),
  Type.Literal('ban_user'),
  Type.Literal('unban_user'),
]);
export type AccountModerationAction = Static<typeof AccountModerationActionSchema>;

export const PhotoModerationActionSchema = Type.Union([
  Type.Literal('hide_photo'),
  Type.Literal('restore_photo'),
  Type.Literal('delete_photo'),
]);
export type PhotoModerationAction = Static<typeof PhotoModerationActionSchema>;

export const SupportThreadStatusSchema = Type.Union([Type.Literal('open'), Type.Literal('closed')]);
export type SupportThreadStatus = Static<typeof SupportThreadStatusSchema>;

export const AppealStatusSchema = Type.Union([
  Type.Literal('submitted'),
  Type.Literal('in_review'),
  Type.Literal('accepted'),
  Type.Literal('rejected'),
]);
export type AppealStatus = Static<typeof AppealStatusSchema>;

export const M7EventTypeSchema = Type.Union([
  Type.Literal('moderation.report-submitted.v1'),
  Type.Literal('moderation.threshold-reached.v1'),
  Type.Literal('moderation.review-decided.v1'),
  Type.Literal('moderation.action-recorded.v1'),
  Type.Literal('moderation.internal-block-changed.v1'),
  Type.Literal('administration.action-attempted.v1'),
  Type.Literal('support.thread-changed.v1'),
  Type.Literal('moderation.appeal-changed.v1'),
]);
export type M7EventType = Static<typeof M7EventTypeSchema>;

export const PrepareReportEvidenceQuerySchema = Type.Object(
  {
    actor: UserActorSchema,
    requestId: UuidSchema,
    sourceActionToken: EvidenceSourceTokenSchema,
    requestedEvidenceTypes: Type.Array(ReportEvidenceTypeSchema, {
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type PrepareReportEvidenceQuery = Static<typeof PrepareReportEvidenceQuerySchema>;

export const SubmitReportCommandSchema = mutationSchema(
  'moderation.submit-report',
  UserActorSchema,
  Type.Object(
    {
      evidenceIntentToken: EvidenceIntentTokenSchema,
      reasonCode: SafeCodeSchema,
      text: Type.Optional(ReportTextSchema),
    },
    { additionalProperties: false },
  ),
);
export type SubmitReportCommand = Static<typeof SubmitReportCommandSchema>;

export const GetReportMetadataPageQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    status: Type.Optional(ReportStatusSchema),
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    cursor: Type.Optional(PageCursorSchema),
  },
  { additionalProperties: false },
);
export type GetReportMetadataPageQuery = Static<typeof GetReportMetadataPageQuerySchema>;

export const ClaimModerationReviewsCommandSchema = mutationSchema(
  'moderation.claim-reviews',
  AdminActorSchema,
  Type.Object(
    {
      adminActionToken: AdminActionTokenSchema,
      limit: Type.Integer({ minimum: 1, maximum: 50 }),
    },
    { additionalProperties: false },
  ),
);
export type ClaimModerationReviewsCommand = Static<typeof ClaimModerationReviewsCommandSchema>;

const AdminMutationFields = {
  adminActionToken: AdminActionTokenSchema,
  confirmationToken: ConfirmationTokenSchema,
  expectedTargetVersion: Type.Integer({ minimum: 1 }),
  reason: AdminReasonSchema,
};

export const AssignModerationReviewCommandSchema = mutationSchema(
  'moderation.assign-review',
  AdminActorSchema,
  Type.Object(
    { ...AdminMutationFields, assigneeAdminId: UuidSchema },
    { additionalProperties: false },
  ),
);
export type AssignModerationReviewCommand = Static<typeof AssignModerationReviewCommandSchema>;

export const DecideModerationReviewCommandSchema = mutationSchema(
  'moderation.decide-review',
  AdminActorSchema,
  Type.Object(
    {
      ...AdminMutationFields,
      decision: Type.Union([Type.Literal('dismissed'), Type.Literal('actioned')]),
      note: Type.Optional(ReviewNoteSchema),
    },
    { additionalProperties: false },
  ),
);
export type DecideModerationReviewCommand = Static<typeof DecideModerationReviewCommandSchema>;

export const RevealReportEvidenceCommandSchema = mutationSchema(
  'moderation.reveal-evidence',
  AdminActorSchema,
  Type.Object(
    {
      adminActionToken: AdminActionTokenSchema,
      confirmationToken: ConfirmationTokenSchema,
      evidenceId: UuidSchema,
      reason: AdminReasonSchema,
    },
    { additionalProperties: false },
  ),
);
export type RevealReportEvidenceCommand = Static<typeof RevealReportEvidenceCommandSchema>;

export const ApplyAccountModerationActionCommandSchema = mutationSchema(
  'moderation.apply-account-action',
  AdminActorSchema,
  Type.Object(
    { ...AdminMutationFields, action: AccountModerationActionSchema },
    { additionalProperties: false },
  ),
);
export type ApplyAccountModerationActionCommand = Static<
  typeof ApplyAccountModerationActionCommandSchema
>;

export const ApplyPhotoModerationActionCommandSchema = mutationSchema(
  'moderation.apply-photo-action',
  AdminActorSchema,
  Type.Object(
    { ...AdminMutationFields, action: PhotoModerationActionSchema },
    { additionalProperties: false },
  ),
);
export type ApplyPhotoModerationActionCommand = Static<
  typeof ApplyPhotoModerationActionCommandSchema
>;

export const ChangeInternalBlockCommandSchema = mutationSchema(
  'moderation.change-internal-block',
  AdminActorSchema,
  Type.Object(
    {
      ...AdminMutationFields,
      action: Type.Union([Type.Literal('create'), Type.Literal('remove')]),
    },
    { additionalProperties: false },
  ),
);
export type ChangeInternalBlockCommand = Static<typeof ChangeInternalBlockCommandSchema>;

export const OpenSupportThreadCommandSchema = mutationSchema(
  'support.open-thread',
  UserActorSchema,
  Type.Object({ text: RestrictedLongTextSchema }, { additionalProperties: false }),
);
export type OpenSupportThreadCommand = Static<typeof OpenSupportThreadCommandSchema>;

export const SendSupportMessageCommandSchema = mutationSchema(
  'support.send-message',
  UserActorSchema,
  Type.Object(
    {
      supportActionToken: SupportActionTokenSchema,
      text: RestrictedLongTextSchema,
      expectedVersion: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type SendSupportMessageCommand = Static<typeof SendSupportMessageCommandSchema>;

export const ReplySupportThreadCommandSchema = mutationSchema(
  'support.reply-thread',
  AdminActorSchema,
  Type.Object(
    { ...AdminMutationFields, text: RestrictedLongTextSchema },
    { additionalProperties: false },
  ),
);
export type ReplySupportThreadCommand = Static<typeof ReplySupportThreadCommandSchema>;

export const CloseSupportThreadCommandSchema = mutationSchema(
  'support.close-thread',
  AdminActorSchema,
  Type.Object(AdminMutationFields, { additionalProperties: false }),
);
export type CloseSupportThreadCommand = Static<typeof CloseSupportThreadCommandSchema>;

export const SubmitAppealCommandSchema = mutationSchema(
  'moderation.submit-appeal',
  UserActorSchema,
  Type.Object(
    { banActionToken: BanActionTokenSchema, text: RestrictedLongTextSchema },
    { additionalProperties: false },
  ),
);
export type SubmitAppealCommand = Static<typeof SubmitAppealCommandSchema>;

export const ReviewAppealCommandSchema = mutationSchema(
  'moderation.review-appeal',
  AdminActorSchema,
  Type.Object(
    {
      ...AdminMutationFields,
      decision: Type.Union([Type.Literal('accepted'), Type.Literal('rejected')]),
      note: Type.Optional(ReviewNoteSchema),
    },
    { additionalProperties: false },
  ),
);
export type ReviewAppealCommand = Static<typeof ReviewAppealCommandSchema>;

export const BootstrapAdminCommandSchema = mutationSchema(
  'administration.bootstrap-admin',
  SystemActorSchema,
  Type.Object(
    {
      targetIdentityToken: AdminActionTokenSchema,
      confirmationToken: ConfirmationTokenSchema,
      initialRoleCode: SafeCodeSchema,
      reason: AdminReasonSchema,
    },
    { additionalProperties: false },
  ),
);
export type BootstrapAdminCommand = Static<typeof BootstrapAdminCommandSchema>;

export const DisableAdminCommandSchema = mutationSchema(
  'administration.disable-admin',
  AdminActorSchema,
  Type.Object(AdminMutationFields, { additionalProperties: false }),
);
export type DisableAdminCommand = Static<typeof DisableAdminCommandSchema>;

export const AssignAdminRoleCommandSchema = mutationSchema(
  'administration.assign-role',
  AdminActorSchema,
  Type.Object(
    { ...AdminMutationFields, roleCode: SafeCodeSchema },
    { additionalProperties: false },
  ),
);
export type AssignAdminRoleCommand = Static<typeof AssignAdminRoleCommandSchema>;

export const ReconcileM7CommandSchema = mutationSchema(
  'moderation.reconcile',
  SystemActorSchema,
  Type.Object(
    {
      runId: UuidSchema,
      phase: Type.Union([
        Type.Literal('reports'),
        Type.Literal('thresholds'),
        Type.Literal('administration'),
        Type.Literal('support_appeals'),
      ]),
      limit: Type.Integer({ minimum: 1, maximum: 500 }),
      cursor: Type.Optional(PageCursorSchema),
    },
    { additionalProperties: false },
  ),
);
export type ReconcileM7Command = Static<typeof ReconcileM7CommandSchema>;

export const GetM7OperationalHealthQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
  },
  { additionalProperties: false },
);
export type GetM7OperationalHealthQuery = Static<typeof GetM7OperationalHealthQuerySchema>;

export const PreparedReportEvidenceSchema = Type.Object(
  {
    evidenceIntentToken: EvidenceIntentTokenSchema,
    evidenceTypes: Type.Array(ReportEvidenceTypeSchema, {
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
    }),
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export type PreparedReportEvidence = Static<typeof PreparedReportEvidenceSchema>;

export const ReportSubmissionResultSchema = Type.Object(
  {
    reportId: UuidSchema,
    status: Type.Union([Type.Literal('submitted'), Type.Literal('pending_review')]),
    submittedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ReportSubmissionResult = Static<typeof ReportSubmissionResultSchema>;

const ReportMetadataItemSchema = Type.Object(
  {
    reportId: UuidSchema,
    reasonCode: SafeCodeSchema,
    evidenceTypes: Type.Array(ReportEvidenceTypeSchema, {
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
    }),
    status: ReportStatusSchema,
    priority: Type.Union([Type.Literal('normal'), Type.Literal('threshold')]),
    submittedAt: UtcTimestampSchema,
    priorReportCount: Type.Integer({ minimum: 0 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ReportMetadataPageSchema = Type.Object(
  {
    items: Type.Array(ReportMetadataItemSchema, { maxItems: 50 }),
    nextCursor: Type.Optional(PageCursorSchema),
  },
  { additionalProperties: false },
);
export type ReportMetadataPage = Static<typeof ReportMetadataPageSchema>;

export const ModerationMutationResultSchema = Type.Object(
  {
    actionId: UuidSchema,
    status: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('rejected'),
      Type.Literal('failed'),
    ]),
    safeCode: SafeCodeSchema,
    targetVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    occurredAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ModerationMutationResult = Static<typeof ModerationMutationResultSchema>;

const RevealedEvidenceContentSchema = Type.Union([
  Type.Object(
    {
      evidenceType: Type.Literal('profile'),
      displayName: Type.String({ minLength: 1, maxLength: 80 }),
      birthYear: Type.Integer({ minimum: 1900, maximum: 9999 }),
      bio: Type.Optional(Type.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      evidenceType: Type.Literal('photo'),
      evidenceObjectRef: Type.String({ minLength: 16, maxLength: 512 }),
      contentSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      primary: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      evidenceType: Type.Literal('chat'),
      chatSessionId: UuidSchema,
      status: Type.Union([Type.Literal('active'), Type.Literal('closed')]),
      closedAt: Type.Optional(UtcTimestampSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      evidenceType: Type.Literal('message'),
      messageId: UuidSchema,
      messageType: Type.Union([
        Type.Literal('predefined_question'),
        Type.Literal('predefined_answer'),
        Type.Literal('text'),
        Type.Literal('system'),
      ]),
      content: Type.String({ minLength: 1, maxLength: 2000 }),
      createdAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      evidenceType: Type.Literal('unmatched_user'),
      unmatchedAt: UtcTimestampSchema,
      reportWindowExpiresAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const RevealedReportEvidenceSchema = Type.Object(
  {
    evidenceId: UuidSchema,
    snapshotSchemaVersion: Type.Integer({ minimum: 1 }),
    content: RevealedEvidenceContentSchema,
    accessedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export type RevealedReportEvidence = Static<typeof RevealedReportEvidenceSchema>;

export const SupportThreadResultSchema = Type.Object(
  {
    supportThreadId: UuidSchema,
    supportActionToken: SupportActionTokenSchema,
    status: SupportThreadStatusSchema,
    unansweredUserMessages: Type.Integer({ minimum: 0, maximum: 2 }),
    version: Type.Integer({ minimum: 1 }),
    changedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SupportThreadResult = Static<typeof SupportThreadResultSchema>;

export const AppealResultSchema = Type.Object(
  {
    appealId: UuidSchema,
    status: AppealStatusSchema,
    version: Type.Integer({ minimum: 1 }),
    changedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AppealResult = Static<typeof AppealResultSchema>;

export const M7OperationalHealthSchema = Type.Object(
  {
    sampledAt: UtcTimestampSchema,
    oldestPendingReportAgeSeconds: Type.Integer({ minimum: 0 }),
    oldestInReviewAgeSeconds: Type.Integer({ minimum: 0 }),
    thresholdMismatchCount: Type.Integer({ minimum: 0 }),
    adminLogMismatchCount: Type.Integer({ minimum: 0 }),
    snapshotIntegrityFailureCount: Type.Integer({ minimum: 0 }),
    supportLimitMismatchCount: Type.Integer({ minimum: 0 }),
    appealUniquenessMismatchCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type M7OperationalHealth = Static<typeof M7OperationalHealthSchema>;
