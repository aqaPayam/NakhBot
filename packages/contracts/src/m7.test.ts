import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  AppealResultSchema,
  AdminEvidenceRevealResultSchema,
  AdminCommandReceiptSchema,
  AdminSupportRevealResultSchema,
  AdminAppealRevealResultSchema,
  ApplyAccountModerationActionCommandSchema,
  AssignAdminRoleCommandSchema,
  BootstrapAdminCommandSchema,
  ChangeInternalBlockCommandSchema,
  GetM7OperationalHealthQuerySchema,
  GetReportMetadataPageQuerySchema,
  M7EventTypeSchema,
  M7OperationalHealthSchema,
  PrepareReportEvidenceQuerySchema,
  PreparedReportEvidenceSchema,
  ReconcileM7CommandSchema,
  ReportMetadataPageSchema,
  PrepareSelectedReportReviewQuerySchema,
  PrepareSelectedReportAccountActionQuerySchema,
  PreparedReportAccountActionSchema,
  PrepareSelectedReportPhotoActionQuerySchema,
  PreparedReportPhotoActionSchema,
  GetSelectedReportEvidenceMetadataQuerySchema,
  PreparedSelectedReportReviewSchema,
  ReportEvidenceMetadataSchema,
  ReportSubmissionResultSchema,
  RevealReportEvidenceCommandSchema,
  RevealedReportEvidenceSchema,
  SendSupportMessageCommandSchema,
  SubmitAppealCommandSchema,
  UnbanAppealCommandSchema,
  SubmitReportCommandSchema,
  SupportThreadResultSchema,
} from './index.js';

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;
function validator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe('report evidence metadata privacy contract', () => {
  it('accepts only queue report selection and server-derived review authority without content', () => {
    const id = '20000000-0000-4000-8000-000000000000';
    const token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`;
    const query = {
      actor: { kind: 'admin', userId: id },
      requestId: id,
      adminActionToken: token,
      reportId: id,
      expectedReportVersion: 2,
      action: 'assign',
    };
    const validate = validator(PrepareSelectedReportReviewQuerySchema);
    expect(validate(query)).toBe(true);
    for (const action of ['dismissed', 'actioned'])
      expect(validate({ ...query, action })).toBe(true);
    for (const key of [
      'reviewId',
      'expectedReviewVersion',
      'assigneeAdminId',
      'reporterId',
      'text',
    ])
      expect(validate({ ...query, [key]: id })).toBe(false);
    expect(validate({ ...query, actor: { kind: 'user', userId: id } })).toBe(false);
    expect(validate({ ...query, expectedReportVersion: 0 })).toBe(false);
    expect(validate({ ...query, action: 'ban_user' })).toBe(false);
    const result = { adminActionToken: token, reviewId: id, reviewVersion: 1, assigneeAdminId: id };
    const validateResult = validator(PreparedSelectedReportReviewSchema);
    expect(validateResult(result)).toBe(true);
    for (const key of ['reporterId', 'targetUserId', 'text', 'note', 'telegramUserId'])
      expect(validateResult({ ...result, [key]: id })).toBe(false);
  });
  it('exposes appeal prose only on fresh audited success and never permits ban or user identity', () => {
    const validate = validator(AdminAppealRevealResultSchema);
    const receipt = {
      auditId: '20000000-0000-4000-8000-000000000000',
      result: 'succeeded',
      safeCode: 'completed',
      recordedAt: '2026-10-04T12:00:00.000Z',
      replayed: false,
    };
    const appeal = {
      appealVersion: 2,
      status: 'accepted',
      text: 'Private appeal',
      note: 'Private note',
    };
    expect(validate({ ...receipt, appeal })).toBe(true);
    expect(validate({ ...receipt, appeal, replayed: true })).toBe(false);
    expect(validate({ ...receipt, appeal, result: 'rejected', safeCode: 'forbidden' })).toBe(false);
    for (const identity of ['userId', 'banHistoryId', 'reviewedByAdminId'])
      expect(validate({ ...receipt, appeal: { ...appeal, [identity]: receipt.auditId } })).toBe(
        false,
      );
    expect(validate({ ...receipt, replayed: true })).toBe(true);
  });
  it('never permits support content on replay or rejection or sender identities in a fresh read', () => {
    const validate = validator(AdminSupportRevealResultSchema);
    const receipt = {
      auditId: '20000000-0000-4000-8000-000000000000',
      result: 'succeeded',
      safeCode: 'completed',
      recordedAt: '2026-10-04T12:00:00.000Z',
      replayed: false,
    };
    const thread = {
      threadVersion: 1,
      status: 'open',
      hasEarlierMessages: false,
      messages: [{ senderType: 'user', text: 'Restricted text', createdAt: receipt.recordedAt }],
    };
    expect(validate({ ...receipt, thread })).toBe(true);
    expect(validate({ ...receipt, thread, replayed: true })).toBe(false);
    expect(validate({ ...receipt, thread, result: 'rejected', safeCode: 'forbidden' })).toBe(false);
    expect(validate({ ...receipt, thread: { ...thread, userId: receipt.auditId } })).toBe(false);
    expect(
      validate({
        ...receipt,
        thread: { ...thread, messages: [{ ...thread.messages[0], senderUserId: receipt.auditId }] },
      }),
    ).toBe(false);
    expect(
      validate({
        ...receipt,
        thread: { ...thread, messages: Array.from({ length: 51 }, () => thread.messages[0]) },
      }),
    ).toBe(false);
    expect(validate({ ...receipt, replayed: true })).toBe(true);
  });
  it('forbids evidence content on replay or failed outcomes and keeps admin receipts finite', () => {
    const validate = validator(AdminEvidenceRevealResultSchema);
    const receipt = {
      auditId: '20000000-0000-4000-8000-000000000000',
      result: 'succeeded',
      safeCode: 'completed',
      recordedAt: '2026-10-04T12:00:00.000Z',
      replayed: true,
    };
    const evidence = {
      evidenceId: receipt.auditId,
      snapshotSchemaVersion: 1,
      accessedAt: receipt.recordedAt,
      content: {
        evidenceType: 'message',
        messageId: receipt.auditId,
        messageType: 'text',
        content: 'Private message',
        createdAt: receipt.recordedAt,
      },
    };
    expect(validate(receipt)).toBe(true);
    expect(validate({ ...receipt, replayed: false, evidence })).toBe(true);
    expect(validate({ ...receipt, replayed: false })).toBe(false);
    for (const result of ['succeeded', 'rejected', 'failed'])
      expect(validate({ ...receipt, result, evidence })).toBe(false);
    expect(validator(AdminCommandReceiptSchema)({ ...receipt, value: evidence })).toBe(false);
    expect(
      validator(AdminCommandReceiptSchema)({ ...receipt, safeCode: 'private_dynamic_code' }),
    ).toBe(false);
  });
  it('bounds one report selection and rejects content and identity fields', () => {
    const validate = validator(ReportEvidenceMetadataSchema);
    const item = {
      evidenceId: '20000000-0000-4000-8000-000000000000',
      evidenceType: 'profile',
      snapshotSchemaVersion: 1,
    };
    const result = { reportId: '10000000-0000-4000-8000-000000000000', items: [item] };
    expect(validate(result)).toBe(true);
    for (const field of ['content', 'ciphertext', 'reporterUserId', 'targetUserId', 'keyId'])
      expect(validate({ ...result, items: [{ ...item, [field]: 'private' }] })).toBe(false);
    expect(validate({ ...result, items: Array.from({ length: 6 }, () => item) })).toBe(false);
  });
});

const userId = '10000000-0000-4000-8000-000000000000';
const entityId = '20000000-0000-4000-8000-000000000000';
const otherId = '30000000-0000-4000-8000-000000000000';
const requestId = '40000000-0000-4000-8000-000000000000';
const timestamp = '2026-09-26T12:00:00.000Z';
const sourceToken = `v1.rs.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const evidenceIntentToken = `v1.ri.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const adminActionToken = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const confirmationToken = `v1.cf.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const supportActionToken = `v1.sp.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const banActionToken = `v1.bn.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const cursor = `v1.m7.${'a'.repeat(16)}.${'b'.repeat(16)}`;

const userEnvelope = {
  commandId: entityId,
  schemaVersion: 1,
  actor: { userId, kind: 'user' },
  requestId,
  idempotencyKey: 'stable-m7-command',
  occurredAt: timestamp,
  locale: 'en',
};
const adminEnvelope = { ...userEnvelope, actor: { userId, kind: 'admin' } };
const systemEnvelope = { ...userEnvelope, actor: { userId, kind: 'system' } };
const adminMutation = {
  adminActionToken,
  confirmationToken,
  expectedTargetVersion: 2,
  reason: 'Reviewed the evidence',
};

describe('M7 moderation, administration, support, and appeal contracts', () => {
  it('requires a separate confirmed admin unban with both appeal and account versions', () => {
    const validate = validator(UnbanAppealCommandSchema);
    const command = {
      ...adminEnvelope,
      commandType: 'moderation.unban-appeal',
      data: { ...adminMutation, expectedAccountVersion: 3 },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, actor: userEnvelope.actor })).toBe(false);
    expect(validate({ ...command, data: adminMutation })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, confirmationToken: undefined } })).toBe(
      false,
    );
    expect(validate({ ...command, data: { ...command.data, targetUserId: otherId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, expectedAccountVersion: 0 } })).toBe(
      false,
    );
  });
  it('prepares actor-bound evidence without accepting an effective target', () => {
    const validate = validator(PrepareReportEvidenceQuerySchema);
    const query = {
      actor: userEnvelope.actor,
      requestId,
      sourceActionToken: sourceToken,
      requestedEvidenceTypes: ['profile', 'message'],
    };
    expect(validate(query)).toBe(true);
    expect(validate({ ...query, targetUserId: otherId })).toBe(false);
    expect(validate({ ...query, reporterUserId: userId })).toBe(false);
    expect(validate({ ...query, requestedEvidenceTypes: ['nakh'] })).toBe(false);
    expect(validate({ ...query, actor: adminEnvelope.actor })).toBe(false);
  });

  it('submits a report from only an opaque intent, reason, and bounded optional text', () => {
    const validate = validator(SubmitReportCommandSchema);
    const command = {
      ...userEnvelope,
      commandType: 'moderation.submit-report',
      data: { evidenceIntentToken, reasonCode: 'harassment', text: 'Evidence context' },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, targetUserId: otherId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, reporterUserId: userId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, text: '🌳'.repeat(1025) } })).toBe(
      false,
    );
    expect(validate({ ...command, actor: adminEnvelope.actor })).toBe(false);
  });

  it('returns minimal report preparation and submission results', () => {
    expect(
      validator(PreparedReportEvidenceSchema)({
        evidenceIntentToken,
        evidenceTypes: ['profile', 'message'],
        expiresAt: timestamp,
      }),
    ).toBe(true);
    const result = {
      reportId: entityId,
      status: 'submitted',
      submittedAt: timestamp,
      replayed: false,
    };
    expect(validator(ReportSubmissionResultSchema)(result)).toBe(true);
    expect(validator(ReportSubmissionResultSchema)({ ...result, targetUserId: otherId })).toBe(
      false,
    );
    expect(validator(ReportSubmissionResultSchema)({ ...result, restricted: true })).toBe(false);
  });

  it('keeps moderation queue pages metadata-only and keyset-only', () => {
    const query = {
      actor: adminEnvelope.actor,
      requestId,
      adminActionToken,
      status: 'pending_review',
      limit: 50,
      cursor,
    };
    expect(validator(GetReportMetadataPageQuerySchema)(query)).toBe(true);
    expect(validator(GetReportMetadataPageQuerySchema)({ ...query, offset: 0 })).toBe(false);
    expect(validator(GetReportMetadataPageQuerySchema)({ ...query, limit: 51 })).toBe(false);

    const item = {
      reportId: entityId,
      reasonCode: 'harassment',
      evidenceTypes: ['profile', 'message'],
      status: 'pending_review',
      priority: 'threshold',
      submittedAt: timestamp,
      priorReportCount: 4,
      version: 1,
    };
    expect(validator(ReportMetadataPageSchema)({ items: [item], nextCursor: cursor })).toBe(true);
    expect(
      validator(ReportMetadataPageSchema)({
        items: [{ ...item, reporterUserId: userId }],
      }),
    ).toBe(false);
    expect(validator(ReportMetadataPageSchema)({ items: [{ ...item, text: 'private' }] })).toBe(
      false,
    );
  });

  it('requires an admin actor, confirmation, reason, version, and opaque target action', () => {
    const validate = validator(ApplyAccountModerationActionCommandSchema);
    const command = {
      ...adminEnvelope,
      commandType: 'moderation.apply-account-action',
      data: { ...adminMutation, action: 'ban_user' },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, actor: userEnvelope.actor })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, confirmationToken: undefined } })).toBe(
      false,
    );
    expect(validate({ ...command, data: { ...command.data, reason: undefined } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, targetUserId: otherId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, permission: 'ban_user' } })).toBe(false);
  });

  it('keeps internal-block targets inside a signed target scope', () => {
    const validate = validator(ChangeInternalBlockCommandSchema);
    const command = {
      ...adminEnvelope,
      commandType: 'moderation.change-internal-block',
      data: { ...adminMutation, action: 'create' },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, firstUserId: userId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, notifyUsers: true } })).toBe(false);
  });

  it('audits evidence reveal as a command and returns one typed snapshot only', () => {
    const command = {
      ...adminEnvelope,
      commandType: 'moderation.reveal-evidence',
      data: { adminActionToken, confirmationToken, evidenceId: entityId, reason: 'Review' },
    };
    expect(validator(RevealReportEvidenceCommandSchema)(command)).toBe(true);
    expect(
      validator(RevealReportEvidenceCommandSchema)({
        ...command,
        data: { ...command.data, bulk: true },
      }),
    ).toBe(false);

    const revealed = {
      evidenceId: entityId,
      snapshotSchemaVersion: 1,
      content: {
        evidenceType: 'photo',
        evidenceObjectRef: 'restricted/object/reference',
        contentSha256: 'a'.repeat(64),
        primary: true,
      },
      accessedAt: timestamp,
    };
    expect(validator(RevealedReportEvidenceSchema)(revealed)).toBe(true);
    expect(
      validator(RevealedReportEvidenceSchema)({
        ...revealed,
        content: { ...revealed.content, objectBytes: 'secret' },
      }),
    ).toBe(false);
  });

  it('keeps support actor-bound, text-bounded, and capped in its result', () => {
    const validate = validator(SendSupportMessageCommandSchema);
    const command = {
      ...userEnvelope,
      commandType: 'support.send-message',
      data: { supportActionToken, text: 'Please help', expectedVersion: 1 },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, supportThreadId: entityId } })).toBe(
      false,
    );
    expect(validate({ ...command, data: { ...command.data, text: 'x'.repeat(2001) } })).toBe(false);
    const result = {
      supportThreadId: entityId,
      supportActionToken,
      status: 'open',
      unansweredUserMessages: 2,
      version: 2,
      changedAt: timestamp,
      replayed: false,
    };
    expect(validator(SupportThreadResultSchema)(result)).toBe(true);
    expect(validator(SupportThreadResultSchema)({ ...result, unansweredUserMessages: 3 })).toBe(
      false,
    );
  });

  it('binds an appeal to an opaque current-ban action and exposes no ban reason', () => {
    const command = {
      ...userEnvelope,
      commandType: 'moderation.submit-appeal',
      data: { banActionToken, text: 'Please reconsider' },
    };
    expect(validator(SubmitAppealCommandSchema)(command)).toBe(true);
    expect(
      validator(SubmitAppealCommandSchema)({
        ...command,
        data: { ...command.data, accountStateHistoryId: otherId },
      }),
    ).toBe(false);
    const result = {
      appealId: entityId,
      status: 'submitted',
      version: 1,
      changedAt: timestamp,
      replayed: false,
    };
    expect(validator(AppealResultSchema)(result)).toBe(true);
    expect(validator(AppealResultSchema)({ ...result, banReason: 'private' })).toBe(false);
  });

  it('bootstraps without raw provider identity and protects later role assignment', () => {
    const bootstrap = {
      ...systemEnvelope,
      commandType: 'administration.bootstrap-admin',
      data: {
        targetIdentityToken: adminActionToken,
        confirmationToken,
        initialRoleCode: 'super_admin',
        reason: 'Initial controlled bootstrap',
      },
    };
    expect(validator(BootstrapAdminCommandSchema)(bootstrap)).toBe(true);
    expect(
      validator(BootstrapAdminCommandSchema)({
        ...bootstrap,
        data: { ...bootstrap.data, telegramUserId: '123456' },
      }),
    ).toBe(false);

    const assignment = {
      ...adminEnvelope,
      commandType: 'administration.assign-role',
      data: { ...adminMutation, roleCode: 'moderator' },
    };
    expect(validator(AssignAdminRoleCommandSchema)(assignment)).toBe(true);
    expect(
      validator(AssignAdminRoleCommandSchema)({
        ...assignment,
        data: { ...assignment.data, permissions: ['ban_user'] },
      }),
    ).toBe(false);
  });

  it('bounds reconciliation and exposes only aggregate operational health', () => {
    const reconciliation = {
      ...systemEnvelope,
      commandType: 'moderation.reconcile',
      data: { runId: otherId, phase: 'reports', limit: 500, cursor },
    };
    expect(validator(ReconcileM7CommandSchema)(reconciliation)).toBe(true);
    expect(
      validator(ReconcileM7CommandSchema)({
        ...reconciliation,
        data: { ...reconciliation.data, limit: 501 },
      }),
    ).toBe(false);
    const query = { actor: adminEnvelope.actor, requestId, adminActionToken };
    expect(validator(GetM7OperationalHealthQuerySchema)(query)).toBe(true);
    const health = {
      sampledAt: timestamp,
      oldestPendingReportAgeSeconds: 10,
      oldestInReviewAgeSeconds: 20,
      thresholdMismatchCount: 0,
      adminLogMismatchCount: 0,
      snapshotIntegrityFailureCount: 0,
      supportLimitMismatchCount: 0,
      appealUniquenessMismatchCount: 0,
    };
    expect(validator(M7OperationalHealthSchema)(health)).toBe(true);
    expect(validator(M7OperationalHealthSchema)({ ...health, reportId: entityId })).toBe(false);
  });

  it('locks every M7 event name to an explicit version', () => {
    const validate = validator(M7EventTypeSchema);
    for (const eventType of [
      'moderation.report-submitted.v1',
      'moderation.threshold-reached.v1',
      'administration.action-attempted.v1',
      'support.thread-changed.v1',
      'moderation.appeal-changed.v1',
    ])
      expect(validate(eventType)).toBe(true);
    expect(validate('moderation.report-submitted')).toBe(false);
    expect(validate('moderation.reporter-exposed.v1')).toBe(false);
  });
});

describe('selected report Account preparation privacy contract', () => {
  it('accepts only Report selection and one native account action with no client target authority or prose', () => {
    const id = '20000000-0000-4000-8000-000000000000',
      token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`;
    const query = {
      actor: { kind: 'admin', userId: id },
      requestId: id,
      adminActionToken: token,
      reportId: id,
      expectedReportVersion: 2,
      action: 'restrict_user',
    };
    const validate = validator(PrepareSelectedReportAccountActionQuerySchema);
    for (const action of ['restrict_user', 'unrestrict_user', 'ban_user', 'unban_user'])
      expect(validate({ ...query, action })).toBe(true);
    for (const key of [
      'reviewId',
      'expectedReviewVersion',
      'targetUserId',
      'expectedAccountVersion',
      'sourceReportId',
      'reason',
      'note',
      'text',
    ])
      expect(validate({ ...query, [key]: id })).toBe(false);
    expect(validate({ ...query, actor: { kind: 'user', userId: id } })).toBe(false);
    expect(validate({ ...query, expectedReportVersion: 0 })).toBe(false);
    expect(validate({ ...query, action: 'dismissed' })).toBe(false);
    const result = { adminActionToken: token, accountVersion: 3 },
      output = validator(PreparedReportAccountActionSchema);
    expect(output(result)).toBe(true);
    for (const key of ['reviewId', 'reportId', 'targetUserId', 'telegramUserId', 'text'])
      expect(output({ ...result, [key]: id })).toBe(false);
  });
});

describe('selected Report photo/evidence contracts', () => {
  it('permits only Report/evidence selection and rejects photo identities, client authority and prose', () => {
    const id = '20000000-0000-4000-8000-000000000000',
      token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`;
    const base = {
      actor: { kind: 'admin', userId: id },
      requestId: id,
      adminActionToken: token,
      reportId: id,
      expectedReportVersion: 2,
    };
    const metadata = validator(GetSelectedReportEvidenceMetadataQuerySchema),
      photo = validator(PrepareSelectedReportPhotoActionQuerySchema);
    expect(metadata(base)).toBe(true);
    const query = { ...base, evidenceId: id, action: 'hide_photo' };
    for (const action of ['hide_photo', 'restore_photo', 'delete_photo'])
      expect(photo({ ...query, action })).toBe(true);
    for (const key of [
      'photoId',
      'expectedPhotoVersion',
      'reviewId',
      'expectedReviewVersion',
      'targetUserId',
      'reason',
      'text',
    ]) {
      expect(photo({ ...query, [key]: id })).toBe(false);
      expect(metadata({ ...base, [key]: id })).toBe(false);
    }
    expect(metadata({ ...base, evidenceId: id })).toBe(false);
    expect(photo({ ...query, action: 'ban_user' })).toBe(false);
    expect(photo({ ...query, expectedReportVersion: 0 })).toBe(false);
    const output = validator(PreparedReportPhotoActionSchema),
      result = { adminActionToken: token, photoVersion: 1 };
    expect(output(result)).toBe(true);
    for (const key of ['photoId', 'assetId', 'objectKey', 'url', 'evidenceId', 'targetUserId'])
      expect(output({ ...result, [key]: id })).toBe(false);
  });
});
