import { M7_PERMISSIONS, type ApplicationErrorCode, type M7Permission } from '@nakh/domain';

import { canonicalAdminPairTargetId } from './admin-authorization.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const COMMAND_CODE = /^[a-z][a-z0-9_.-]{0,119}$/u;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,79}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const permissionCodes = new Set<string>(M7_PERMISSIONS);

export type AdminActionResult = 'succeeded' | 'rejected' | 'failed';

export type AdminCommandAttempt = Readonly<{
  logId: string;
  adminUserId: string;
  commandId: string;
  requestId: string;
  requestDigest: string;
  commandCode: string;
  requiredPermission: M7Permission;
  targetType: string;
  targetId: string;
  expectedTargetVersion: number | null;
  reasonDigest: string;
  metadata: Readonly<Record<string, unknown>>;
  correlationId: string;
  /** Trusted adapter rejection, checked inside the auditable transaction before any effect. */
  preconditionRejection?: 'invalid_request' | 'version_conflict' | 'admin_reason_invalid';
  /** Trusted pair claims recovered from an opaque admin action token. */
  targetPair?: Readonly<{ userLowId: string; userHighId: string }>;
  sourceReportId?: string;
}>;

export type AdminCommandEffectResult<T> = Readonly<{
  value: T;
  safeCode: string;
}>;

export type AdminCommandExecutionResult<T> = Readonly<{
  logId: string;
  result: AdminActionResult;
  safeCode: string;
  recordedAt: Date;
  replayed: boolean;
  /** Present only for the process that committed a successful effect. Replays reload domain state. */
  value: T | undefined;
}>;

export type EvidenceAccessAttempt = Readonly<{
  auditId: string;
  reportId: string;
  reportEvidenceId: string;
  adminUserId: string;
  reasonCode: string;
  requestId: string;
  commandId: string;
  permissionCode: 'view_reports';
  outcome: 'revealed' | 'rejected';
  safeCode: string;
}>;

export type EvidenceAccessResult = Readonly<{
  auditId: string;
  outcome: 'revealed' | 'rejected';
  safeCode: string;
  accessedAt: Date;
  replayed: boolean;
}>;

export interface AdminCommandExecutionStore<TContext> {
  execute<T>(
    attempt: AdminCommandAttempt,
    effect: (context: TContext) => Promise<AdminCommandEffectResult<T>>,
  ): Promise<AdminCommandExecutionResult<T>>;
  recordEvidenceAccess(attempt: EvidenceAccessAttempt): Promise<EvidenceAccessResult>;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function isAdminSafeCode(value: string): boolean {
  return SAFE_CODE.test(value);
}

export function validateAdminCommandAttempt(attempt: AdminCommandAttempt): void {
  let metadataLength = Number.POSITIVE_INFINITY;
  try {
    const encoded = JSON.stringify(attempt.metadata);
    if (encoded !== undefined) metadataLength = Buffer.byteLength(encoded, 'utf8');
  } catch {
    // Cyclic or otherwise non-serializable metadata is invalid at the trust boundary.
  }
  let pairValid = attempt.targetPair === undefined;
  if (attempt.targetPair !== undefined) {
    try {
      pairValid =
        attempt.targetType === 'user_pair' &&
        canonicalAdminPairTargetId(attempt.targetPair) === attempt.targetId;
    } catch {
      pairValid = false;
    }
  }
  if (
    !isUuid(attempt.logId) ||
    !isUuid(attempt.adminUserId) ||
    !isUuid(attempt.commandId) ||
    !isUuid(attempt.requestId) ||
    !DIGEST.test(attempt.requestDigest) ||
    !COMMAND_CODE.test(attempt.commandCode) ||
    !permissionCodes.has(attempt.requiredPermission) ||
    !TARGET_TYPE.test(attempt.targetType) ||
    !isUuid(attempt.targetId) ||
    (attempt.expectedTargetVersion !== null &&
      (!Number.isSafeInteger(attempt.expectedTargetVersion) ||
        attempt.expectedTargetVersion < 1)) ||
    !DIGEST.test(attempt.reasonDigest) ||
    !isObject(attempt.metadata) ||
    metadataLength > 4_096 ||
    !isUuid(attempt.correlationId) ||
    (attempt.preconditionRejection !== undefined &&
      !['invalid_request', 'version_conflict', 'admin_reason_invalid'].includes(
        attempt.preconditionRejection,
      )) ||
    !pairValid ||
    (attempt.sourceReportId !== undefined &&
      (!isUuid(attempt.sourceReportId) ||
        attempt.commandCode !== 'moderation.apply-account-action' ||
        attempt.targetType !== 'user')) ||
    (attempt.targetType === 'user_pair') !== (attempt.targetPair !== undefined)
  )
    throw new Error('Admin command attempt is invalid.');
}

export function validateEvidenceAccessAttempt(attempt: EvidenceAccessAttempt): void {
  if (
    !isUuid(attempt.auditId) ||
    !isUuid(attempt.reportId) ||
    !isUuid(attempt.reportEvidenceId) ||
    !isUuid(attempt.adminUserId) ||
    !SAFE_CODE.test(attempt.reasonCode) ||
    !isUuid(attempt.requestId) ||
    !isUuid(attempt.commandId) ||
    attempt.permissionCode !== 'view_reports' ||
    (attempt.outcome !== 'revealed' && attempt.outcome !== 'rejected') ||
    !SAFE_CODE.test(attempt.safeCode)
  )
    throw new Error('Evidence access attempt is invalid.');
}

/** Only finite public error codes may cross from an expected rejection into an audit row. */
export function adminRejectionSafeCode(code: ApplicationErrorCode): string {
  return code;
}
