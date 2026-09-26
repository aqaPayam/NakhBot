import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  AppealResultSchema,
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
  ReportSubmissionResultSchema,
  RevealReportEvidenceCommandSchema,
  RevealedReportEvidenceSchema,
  SendSupportMessageCommandSchema,
  SubmitAppealCommandSchema,
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
    expect(validate({ ...command, data: { ...command.data, permission: 'ban_users' } })).toBe(
      false,
    );
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
        data: { ...assignment.data, permissions: ['ban_users'] },
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
