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
  Type.Literal('view_user_profile'),
  Type.Literal('restrict_user'),
  Type.Literal('unrestrict_user'),
  Type.Literal('ban_user'),
  Type.Literal('unban_user'),
  Type.Literal('hide_photo'),
  Type.Literal('restore_photo'),
  Type.Literal('delete_photo'),
  Type.Literal('dismiss_report'),
  Type.Literal('manage_internal_blocks'),
  Type.Literal('review_change_requests'),
  Type.Literal('review_support'),
  Type.Literal('review_appeals'),
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

export const GetReportReasonsQuerySchema = Type.Object(
  { actor: UserActorSchema, requestId: UuidSchema },
  { additionalProperties: false },
);
export type GetReportReasonsQuery = Static<typeof GetReportReasonsQuerySchema>;
export const ReportReasonCatalogSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          code: SafeCodeSchema,
          labelKey: Type.String({
            minLength: 1,
            maxLength: 160,
            pattern: '^[a-z][a-z0-9_.]{0,159}$',
          }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
  },
  { additionalProperties: false },
);
export type ReportReasonCatalog = Static<typeof ReportReasonCatalogSchema>;

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
export const GetAdminReportQueueActionsQuerySchema = Type.Object(
  { actor: AdminActorSchema, requestId: UuidSchema },
  { additionalProperties: false },
);
export type GetAdminReportQueueActionsQuery = Static<typeof GetAdminReportQueueActionsQuerySchema>;
export const AdminReportQueueActionsSchema = Type.Object(
  { metadataActionToken: AdminActionTokenSchema, claimActionToken: AdminActionTokenSchema },
  { additionalProperties: false },
);
export type AdminReportQueueActions = Static<typeof AdminReportQueueActionsSchema>;
export const PrepareReportEvidenceAccessQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reportId: UuidSchema,
    expectedReportVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type PrepareReportEvidenceAccessQuery = Static<
  typeof PrepareReportEvidenceAccessQuerySchema
>;
export const PreparedReportEvidenceAccessSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, reportVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedReportEvidenceAccess = Static<typeof PreparedReportEvidenceAccessSchema>;
export const PrepareReviewActionQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reviewId: UuidSchema,
    expectedReviewVersion: Type.Integer({ minimum: 1 }),
    action: Type.Union([
      Type.Literal('assign'),
      Type.Literal('dismissed'),
      Type.Literal('actioned'),
    ]),
  },
  { additionalProperties: false },
);
export type PrepareReviewActionQuery = Static<typeof PrepareReviewActionQuerySchema>;
export const PreparedReviewActionSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, reviewVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedReviewAction = Static<typeof PreparedReviewActionSchema>;
export const PrepareSelectedReportReviewQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reportId: UuidSchema,
    expectedReportVersion: Type.Integer({ minimum: 1 }),
    action: Type.Union([
      Type.Literal('assign'),
      Type.Literal('dismissed'),
      Type.Literal('actioned'),
    ]),
  },
  { additionalProperties: false },
);
export type PrepareSelectedReportReviewQuery = Static<
  typeof PrepareSelectedReportReviewQuerySchema
>;
export const PreparedSelectedReportReviewSchema = Type.Object(
  {
    adminActionToken: AdminActionTokenSchema,
    reviewId: UuidSchema,
    reviewVersion: Type.Integer({ minimum: 1 }),
    assigneeAdminId: UuidSchema,
  },
  { additionalProperties: false },
);
export type PreparedSelectedReportReview = Static<typeof PreparedSelectedReportReviewSchema>;
export const PrepareSelectedReportAccountActionQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reportId: UuidSchema,
    expectedReportVersion: Type.Integer({ minimum: 1 }),
    action: AccountModerationActionSchema,
  },
  { additionalProperties: false },
);
export type PrepareSelectedReportAccountActionQuery = Static<
  typeof PrepareSelectedReportAccountActionQuerySchema
>;
export const PrepareReportAccountActionQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reviewId: UuidSchema,
    expectedReviewVersion: Type.Integer({ minimum: 1 }),
    action: AccountModerationActionSchema,
  },
  { additionalProperties: false },
);
export type PrepareReportAccountActionQuery = Static<typeof PrepareReportAccountActionQuerySchema>;
export const PreparedReportAccountActionSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, accountVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedReportAccountAction = Static<typeof PreparedReportAccountActionSchema>;
export const PrepareSelectedReportPhotoActionQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reportId: UuidSchema,
    expectedReportVersion: Type.Integer({ minimum: 1 }),
    evidenceId: UuidSchema,
    action: PhotoModerationActionSchema,
  },
  { additionalProperties: false },
);
export type PrepareSelectedReportPhotoActionQuery = Static<
  typeof PrepareSelectedReportPhotoActionQuerySchema
>;
export const GetSelectedReportEvidenceMetadataQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reportId: UuidSchema,
    expectedReportVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type GetSelectedReportEvidenceMetadataQuery = Static<
  typeof GetSelectedReportEvidenceMetadataQuerySchema
>;
export const PrepareSelectedReportEvidenceRevealQuerySchema = Type.Object(
  {
    ...GetSelectedReportEvidenceMetadataQuerySchema.properties,
    evidenceId: UuidSchema,
  },
  { additionalProperties: false },
);
export type PrepareSelectedReportEvidenceRevealQuery = Static<
  typeof PrepareSelectedReportEvidenceRevealQuerySchema
>;
export const PreparedReportEvidenceRevealSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema },
  { additionalProperties: false },
);
export type PreparedReportEvidenceReveal = Static<typeof PreparedReportEvidenceRevealSchema>;
export const PrepareSelectedReportInternalBlockQuerySchema = Type.Object(
  {
    ...GetSelectedReportEvidenceMetadataQuerySchema.properties,
    action: Type.Union([Type.Literal('create'), Type.Literal('remove')]),
  },
  { additionalProperties: false },
);
export type PrepareSelectedReportInternalBlockQuery = Static<
  typeof PrepareSelectedReportInternalBlockQuerySchema
>;
export const PreparedReportInternalBlockSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, pairVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedReportInternalBlock = Static<typeof PreparedReportInternalBlockSchema>;
export const PrepareReportPhotoActionQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    reviewId: UuidSchema,
    expectedReviewVersion: Type.Integer({ minimum: 1 }),
    evidenceId: UuidSchema,
    action: PhotoModerationActionSchema,
  },
  { additionalProperties: false },
);
export type PrepareReportPhotoActionQuery = Static<typeof PrepareReportPhotoActionQuerySchema>;
export const PreparedReportPhotoActionSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, photoVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedReportPhotoAction = Static<typeof PreparedReportPhotoActionSchema>;
export const GetSafetyQueueActionsQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    queue: Type.Union([Type.Literal('support'), Type.Literal('appeals')]),
  },
  { additionalProperties: false },
);
export type GetSafetyQueueActionsQuery = Static<typeof GetSafetyQueueActionsQuerySchema>;
export const SafetyQueueActionsSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema },
  { additionalProperties: false },
);
export type SafetyQueueActions = Static<typeof SafetyQueueActionsSchema>;
const SafetyMetadataCursorSchema = Type.String({
  pattern: '^v1\\.sq\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{16}$',
});
export const GetSupportMetadataQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    status: Type.Optional(SupportThreadStatusSchema),
    cursor: Type.Optional(SafetyMetadataCursorSchema),
  },
  { additionalProperties: false },
);
export type GetSupportMetadataQuery = Static<typeof GetSupportMetadataQuerySchema>;
export const SupportMetadataPageSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          threadId: UuidSchema,
          status: SupportThreadStatusSchema,
          version: Type.Integer({ minimum: 1 }),
          createdAt: UtcTimestampSchema,
          lastMessageAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    nextCursor: Type.Optional(SafetyMetadataCursorSchema),
  },
  { additionalProperties: false },
);
export type SupportMetadataPage = Static<typeof SupportMetadataPageSchema>;
export const PrepareSupportActionQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    threadId: UuidSchema,
    expectedThreadVersion: Type.Integer({ minimum: 1 }),
    action: Type.Union([Type.Literal('reply'), Type.Literal('close'), Type.Literal('reveal')]),
  },
  { additionalProperties: false },
);
export type PrepareSupportActionQuery = Static<typeof PrepareSupportActionQuerySchema>;
export const PreparedSupportActionSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, threadVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedSupportAction = Static<typeof PreparedSupportActionSchema>;
export const GetAppealMetadataQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
    status: Type.Optional(AppealStatusSchema),
    cursor: Type.Optional(SafetyMetadataCursorSchema),
  },
  { additionalProperties: false },
);
export type GetAppealMetadataQuery = Static<typeof GetAppealMetadataQuerySchema>;
export const AppealMetadataPageSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          appealId: UuidSchema,
          status: AppealStatusSchema,
          version: Type.Integer({ minimum: 1 }),
          submittedAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    nextCursor: Type.Optional(SafetyMetadataCursorSchema),
  },
  { additionalProperties: false },
);
export type AppealMetadataPage = Static<typeof AppealMetadataPageSchema>;
export const PrepareAppealReviewAccessQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    appealId: UuidSchema,
    expectedAppealVersion: Type.Integer({ minimum: 1 }),
    action: Type.Optional(Type.Union([Type.Literal('review'), Type.Literal('reveal')])),
  },
  { additionalProperties: false },
);
export type PrepareAppealReviewAccessQuery = Static<typeof PrepareAppealReviewAccessQuerySchema>;
export const PreparedAppealReviewAccessSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema, appealVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type PreparedAppealReviewAccess = Static<typeof PreparedAppealReviewAccessSchema>;
export const PrepareAppealUnbanAccessQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
    appealId: UuidSchema,
    expectedAppealVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type PrepareAppealUnbanAccessQuery = Static<typeof PrepareAppealUnbanAccessQuerySchema>;
export const PreparedAppealUnbanAccessSchema = Type.Object(
  {
    adminActionToken: AdminActionTokenSchema,
    appealVersion: Type.Integer({ minimum: 1 }),
    accountVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type PreparedAppealUnbanAccess = Static<typeof PreparedAppealUnbanAccessSchema>;
export const GetOwnAdminCommandReceiptQuerySchema = Type.Object(
  { actor: AdminActorSchema, requestId: UuidSchema, commandId: UuidSchema },
  { additionalProperties: false },
);
export type GetOwnAdminCommandReceiptQuery = Static<typeof GetOwnAdminCommandReceiptQuerySchema>;

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
export const PrepareReviewAssignmentCommandSchema = mutationSchema(
  'moderation.assign-review',
  AdminActorSchema,
  Type.Omit(AssignModerationReviewCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareReviewAssignmentCommand = Static<typeof PrepareReviewAssignmentCommandSchema>;

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
export const PrepareReviewDecisionCommandSchema = mutationSchema(
  'moderation.decide-review',
  AdminActorSchema,
  Type.Omit(DecideModerationReviewCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareReviewDecisionCommand = Static<typeof PrepareReviewDecisionCommandSchema>;

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

/** Preparation retains the exact command identity used by the later confirmed execution. */
export const PrepareEvidenceRevealCommandSchema = mutationSchema(
  'moderation.reveal-evidence',
  AdminActorSchema,
  Type.Omit(RevealReportEvidenceCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareEvidenceRevealCommand = Static<typeof PrepareEvidenceRevealCommandSchema>;
export const PreparedAdminConfirmationSchema = Type.Object(
  { confirmationToken: ConfirmationTokenSchema },
  { additionalProperties: false },
);
export type PreparedAdminConfirmation = Static<typeof PreparedAdminConfirmationSchema>;

export const GetReportEvidenceMetadataQuerySchema = Type.Object(
  {
    actor: AdminActorSchema,
    requestId: UuidSchema,
    adminActionToken: AdminActionTokenSchema,
  },
  { additionalProperties: false },
);
export type GetReportEvidenceMetadataQuery = Static<typeof GetReportEvidenceMetadataQuerySchema>;
export const ReportEvidenceMetadataSchema = Type.Object(
  {
    reportId: UuidSchema,
    items: Type.Array(
      Type.Object(
        {
          evidenceId: UuidSchema,
          evidenceType: ReportEvidenceTypeSchema,
          snapshotSchemaVersion: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);
export type ReportEvidenceMetadata = Static<typeof ReportEvidenceMetadataSchema>;

export const ReportEvidenceActionsSchema = Type.Object(
  {
    reportId: UuidSchema,
    items: Type.Array(
      Type.Object(
        {
          evidenceId: UuidSchema,
          evidenceType: ReportEvidenceTypeSchema,
          snapshotSchemaVersion: Type.Integer({ minimum: 1 }),
          revealActionToken: Type.Optional(AdminActionTokenSchema),
        },
        { additionalProperties: false },
      ),
      { maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);
export type ReportEvidenceActions = Static<typeof ReportEvidenceActionsSchema>;

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
export const PrepareAccountModerationActionCommandSchema = mutationSchema(
  'moderation.apply-account-action',
  AdminActorSchema,
  Type.Omit(ApplyAccountModerationActionCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareAccountModerationActionCommand = Static<
  typeof PrepareAccountModerationActionCommandSchema
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
export const PreparePhotoModerationActionCommandSchema = mutationSchema(
  'moderation.apply-photo-action',
  AdminActorSchema,
  Type.Omit(ApplyPhotoModerationActionCommandSchema.properties.data, ['confirmationToken']),
);
export type PreparePhotoModerationActionCommand = Static<
  typeof PreparePhotoModerationActionCommandSchema
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
export const PrepareInternalBlockCommandSchema = mutationSchema(
  'moderation.change-internal-block',
  AdminActorSchema,
  Type.Omit(ChangeInternalBlockCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareInternalBlockCommand = Static<typeof PrepareInternalBlockCommandSchema>;

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
export const PrepareSupportReplyCommandSchema = mutationSchema(
  'support.reply-thread',
  AdminActorSchema,
  Type.Omit(ReplySupportThreadCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareSupportReplyCommand = Static<typeof PrepareSupportReplyCommandSchema>;

export const CloseSupportThreadCommandSchema = mutationSchema(
  'support.close-thread',
  AdminActorSchema,
  Type.Object(AdminMutationFields, { additionalProperties: false }),
);
export type CloseSupportThreadCommand = Static<typeof CloseSupportThreadCommandSchema>;
export const RevealSupportThreadCommandSchema = mutationSchema(
  'support.reveal-thread',
  AdminActorSchema,
  Type.Object(AdminMutationFields, { additionalProperties: false }),
);
export type RevealSupportThreadCommand = Static<typeof RevealSupportThreadCommandSchema>;
export const PrepareSupportRevealCommandSchema = mutationSchema(
  'support.reveal-thread',
  AdminActorSchema,
  Type.Omit(RevealSupportThreadCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareSupportRevealCommand = Static<typeof PrepareSupportRevealCommandSchema>;
export const PrepareSupportCloseCommandSchema = mutationSchema(
  'support.close-thread',
  AdminActorSchema,
  Type.Omit(CloseSupportThreadCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareSupportCloseCommand = Static<typeof PrepareSupportCloseCommandSchema>;

export const SubmitAppealCommandSchema = mutationSchema(
  'moderation.submit-appeal',
  UserActorSchema,
  Type.Object(
    { banActionToken: BanActionTokenSchema, text: RestrictedLongTextSchema },
    { additionalProperties: false },
  ),
);
export type SubmitAppealCommand = Static<typeof SubmitAppealCommandSchema>;
export const PrepareAppealQuerySchema = Type.Object(
  { actor: UserActorSchema, commandId: UuidSchema, requestId: UuidSchema },
  { additionalProperties: false },
);
export type PrepareAppealQuery = Static<typeof PrepareAppealQuerySchema>;
export const PreparedAppealReferenceSchema = Type.Object(
  { banActionToken: BanActionTokenSchema },
  { additionalProperties: false },
);
export type PreparedAppealReference = Static<typeof PreparedAppealReferenceSchema>;

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
export const RevealAppealCommandSchema = mutationSchema(
  'moderation.reveal-appeal',
  AdminActorSchema,
  Type.Object(AdminMutationFields, { additionalProperties: false }),
);
export type RevealAppealCommand = Static<typeof RevealAppealCommandSchema>;
export const PrepareAppealRevealCommandSchema = mutationSchema(
  'moderation.reveal-appeal',
  AdminActorSchema,
  Type.Omit(RevealAppealCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareAppealRevealCommand = Static<typeof PrepareAppealRevealCommandSchema>;
export const PrepareAppealReviewCommandSchema = mutationSchema(
  'moderation.review-appeal',
  AdminActorSchema,
  Type.Omit(ReviewAppealCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareAppealReviewCommand = Static<typeof PrepareAppealReviewCommandSchema>;

export const UnbanAppealCommandSchema = mutationSchema(
  'moderation.unban-appeal',
  AdminActorSchema,
  Type.Object(
    { ...AdminMutationFields, expectedAccountVersion: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
);
export type UnbanAppealCommand = Static<typeof UnbanAppealCommandSchema>;
export const PrepareAppealUnbanCommandSchema = mutationSchema(
  'moderation.unban-appeal',
  AdminActorSchema,
  Type.Omit(UnbanAppealCommandSchema.properties.data, ['confirmationToken']),
);
export type PrepareAppealUnbanCommand = Static<typeof PrepareAppealUnbanCommandSchema>;

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

export const PrepareM7OperationalHealthQuerySchema = Type.Object(
  { actor: AdminActorSchema, requestId: UuidSchema },
  { additionalProperties: false },
);
export type PrepareM7OperationalHealthQuery = Static<typeof PrepareM7OperationalHealthQuerySchema>;
export const PreparedM7OperationalHealthSchema = Type.Object(
  { adminActionToken: AdminActionTokenSchema },
  { additionalProperties: false },
);
export type PreparedM7OperationalHealth = Static<typeof PreparedM7OperationalHealthSchema>;
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

const AdminReceiptFields = {
  auditId: UuidSchema,
  safeCode: Type.Union(
    [
      'completed',
      'forbidden',
      'invalid_request',
      'version_conflict',
      'unavailable',
      'internal_error',
    ].map((code) => Type.Literal(code)),
  ),
  recordedAt: UtcTimestampSchema,
};
export const AdminCommandReceiptSchema = Type.Object(
  {
    ...AdminReceiptFields,
    result: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('rejected'),
      Type.Literal('failed'),
    ]),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminCommandReceipt = Static<typeof AdminCommandReceiptSchema>;
export const RevealedSupportThreadSchema = Type.Object(
  {
    threadVersion: Type.Integer({ minimum: 1 }),
    status: SupportThreadStatusSchema,
    messages: Type.Array(
      Type.Object(
        {
          senderType: Type.Union([Type.Literal('user'), Type.Literal('admin')]),
          text: RestrictedLongTextSchema,
          createdAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    hasEarlierMessages: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RevealedSupportThread = Static<typeof RevealedSupportThreadSchema>;
/** Only a fresh successful audited read includes restricted conversation content. */
export const AdminSupportRevealResultSchema = Type.Union([
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Literal('succeeded'),
      replayed: Type.Literal(false),
      thread: RevealedSupportThreadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AdminReceiptFields, result: Type.Literal('succeeded'), replayed: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Union([Type.Literal('rejected'), Type.Literal('failed')]),
      replayed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type AdminSupportRevealResult = Static<typeof AdminSupportRevealResultSchema>;
export const RevealedAppealSchema = Type.Object(
  {
    appealVersion: Type.Integer({ minimum: 1 }),
    status: AppealStatusSchema,
    text: RestrictedLongTextSchema,
    note: Type.Optional(ReviewNoteSchema),
  },
  { additionalProperties: false },
);
export type RevealedAppeal = Static<typeof RevealedAppealSchema>;
export const AdminAppealRevealResultSchema = Type.Union([
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Literal('succeeded'),
      replayed: Type.Literal(false),
      appeal: RevealedAppealSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AdminReceiptFields, result: Type.Literal('succeeded'), replayed: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Union([Type.Literal('rejected'), Type.Literal('failed')]),
      replayed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type AdminAppealRevealResult = Static<typeof AdminAppealRevealResultSchema>;
export const AdminReviewClaimResultSchema = Type.Union([
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Literal('succeeded'),
      replayed: Type.Literal(false),
      claims: Type.Array(
        Type.Object(
          {
            reviewId: UuidSchema,
            reportId: UuidSchema,
            reviewVersion: Type.Integer({ minimum: 1 }),
            priority: Type.Union([Type.Literal('normal'), Type.Literal('threshold')]),
          },
          { additionalProperties: false },
        ),
        { maxItems: 50 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AdminReceiptFields, result: Type.Literal('succeeded'), replayed: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Union([Type.Literal('rejected'), Type.Literal('failed')]),
      replayed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type AdminReviewClaimResult = Static<typeof AdminReviewClaimResultSchema>;
/** Only the process that committed a successful audited reveal may return its content. */
export const AdminEvidenceRevealResultSchema = Type.Union([
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Literal('succeeded'),
      replayed: Type.Literal(false),
      evidence: RevealedReportEvidenceSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AdminReceiptFields, result: Type.Literal('succeeded'), replayed: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AdminReceiptFields,
      result: Type.Union([Type.Literal('rejected'), Type.Literal('failed')]),
      replayed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type AdminEvidenceRevealResult = Static<typeof AdminEvidenceRevealResultSchema>;

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
/** User HTTP clients address support exclusively through an opaque actor-bound reference. */
export const UserSupportReceiptSchema = Type.Omit(SupportThreadResultSchema, ['supportThreadId']);
export type UserSupportReceipt = Static<typeof UserSupportReceiptSchema>;

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
export const UserAppealReceiptSchema = Type.Omit(AppealResultSchema, ['appealId']);
export type UserAppealReceipt = Static<typeof UserAppealReceiptSchema>;

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
