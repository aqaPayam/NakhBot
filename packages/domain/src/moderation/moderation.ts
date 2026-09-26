import { ApplicationError } from '../foundation.js';
import type { AccountState } from '../identity/account.js';

export const REPORT_TEXT_MAX_SCALARS = 1024;
export const ADMIN_REASON_MAX_SCALARS = 1024;
export const REVIEW_NOTE_MAX_SCALARS = 2000;
export const SUPPORT_TEXT_MAX_SCALARS = 2000;
export const APPEAL_TEXT_MAX_SCALARS = 2000;
export const USER_REPORT_LIMIT = 10;
export const USER_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REPORT_THRESHOLD_DISTINCT_REPORTERS = 5;
export const REPORT_THRESHOLD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SUPPORT_UNANSWERED_LIMIT = 2;

export const REPORT_EVIDENCE_TYPES = [
  'profile',
  'photo',
  'chat',
  'message',
  'unmatched_user',
] as const;
export type ReportEvidenceType = (typeof REPORT_EVIDENCE_TYPES)[number];

export const REPORT_STATUSES = [
  'submitted',
  'pending_review',
  'dismissed',
  'actioned',
  'closed',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const MODERATION_REVIEW_STATUSES = [
  'pending',
  'in_review',
  'dismissed',
  'actioned',
] as const;
export type ModerationReviewStatus = (typeof MODERATION_REVIEW_STATUSES)[number];

export const M7_PERMISSIONS = [
  'view_reports',
  'assign_reports',
  'review_reports',
  'restrict_users',
  'ban_users',
  'moderate_photos',
  'manage_internal_blocks',
  'review_support',
  'review_appeals',
  'manage_admins',
  'run_reconciliation',
  'view_operational_health',
] as const;
export type M7Permission = (typeof M7_PERMISSIONS)[number];

export const MODERATION_ACTION_TYPES = [
  'restrict_user',
  'unrestrict_user',
  'ban_user',
  'unban_user',
  'hide_photo',
  'restore_photo',
  'delete_photo',
  'create_internal_block',
  'remove_internal_block',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

function timestamp(value: Date): number {
  const result = value.getTime();
  if (!Number.isFinite(result))
    throw new ApplicationError('invalid_request', 'error.moderation.time_invalid', 400);
  return result;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function containsUnsafeControlCharacter(value: string): boolean {
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
      return true;
  }
  return false;
}

function normalizeText(
  value: string,
  maximumScalars: number,
  errorCode:
    'report_text_invalid' | 'admin_reason_invalid' | 'support_text_invalid' | 'appeal_text_invalid',
  message: string,
  optional: boolean,
): string | undefined {
  if (containsLoneSurrogate(value)) throw new ApplicationError(errorCode, message, 400);
  const normalized = value.normalize('NFC').trim();
  if (normalized.length === 0) {
    if (optional) return undefined;
    throw new ApplicationError(errorCode, message, 400);
  }
  if ([...normalized].length > maximumScalars || containsUnsafeControlCharacter(normalized))
    throw new ApplicationError(errorCode, message, 400);
  return normalized;
}

export function normalizeReportText(value?: string): string | undefined {
  return value === undefined
    ? undefined
    : normalizeText(
        value,
        REPORT_TEXT_MAX_SCALARS,
        'report_text_invalid',
        'error.report.text_invalid',
        true,
      );
}

export function normalizeAdminReason(value: string): string {
  return normalizeText(
    value,
    ADMIN_REASON_MAX_SCALARS,
    'admin_reason_invalid',
    'error.admin.reason_invalid',
    false,
  )!;
}

export function normalizeReviewNote(value?: string): string | undefined {
  return value === undefined
    ? undefined
    : normalizeText(
        value,
        REVIEW_NOTE_MAX_SCALARS,
        'admin_reason_invalid',
        'error.moderation.review_note_invalid',
        true,
      );
}

export function normalizeSupportText(value: string): string {
  return normalizeText(
    value,
    SUPPORT_TEXT_MAX_SCALARS,
    'support_text_invalid',
    'error.support.text_invalid',
    false,
  )!;
}

export function normalizeAppealText(value: string): string {
  return normalizeText(
    value,
    APPEAL_TEXT_MAX_SCALARS,
    'appeal_text_invalid',
    'error.appeal.text_invalid',
    false,
  )!;
}

export type UserReportAdmission = Readonly<{
  allowed: boolean;
  committedInWindow: number;
  remainingAfterAdmission: number;
}>;

/** Evaluates committed reports in the exact rolling prior 24 hours. */
export function evaluateUserReportAdmission(
  committedReportTimes: readonly Date[],
  now: Date,
): UserReportAdmission {
  const nowTime = timestamp(now);
  const cutoff = nowTime - USER_REPORT_WINDOW_MS;
  let committedInWindow = 0;
  for (const reportTime of committedReportTimes) {
    const value = timestamp(reportTime);
    if (value > nowTime)
      throw new ApplicationError('invalid_request', 'error.report.time_invalid', 400);
    if (value > cutoff) committedInWindow += 1;
  }
  const allowed = committedInWindow < USER_REPORT_LIMIT;
  return {
    allowed,
    committedInWindow,
    remainingAfterAdmission: allowed ? USER_REPORT_LIMIT - committedInWindow - 1 : 0,
  };
}

export type ThresholdReport = Readonly<{
  reporterUserId: string;
  status: ReportStatus;
  submittedAt: Date;
}>;

export type ThresholdOutcome =
  | 'below_threshold'
  | 'create_restriction_episode'
  | 'episode_already_active'
  | 'prioritize_without_transition';

export type ThresholdEvaluation = Readonly<{
  distinctReporterCount: number;
  thresholdReached: boolean;
  outcome: ThresholdOutcome;
  transitionAccount: boolean;
}>;

/** Plans the result under the target advisory lock; it never plans a ban. */
export function evaluateReportThreshold(
  input: Readonly<{
    reports: readonly ThresholdReport[];
    now: Date;
    targetAccountState: AccountState;
    activeEpisode: boolean;
  }>,
): ThresholdEvaluation {
  const now = timestamp(input.now);
  const cutoff = now - REPORT_THRESHOLD_WINDOW_MS;
  const reporters = new Set<string>();
  for (const report of input.reports) {
    const submittedAt = timestamp(report.submittedAt);
    if (report.reporterUserId.length === 0 || submittedAt > now)
      throw new ApplicationError('moderation_state_invalid', 'error.moderation.state_invalid', 400);
    if (
      submittedAt > cutoff &&
      (report.status === 'submitted' || report.status === 'pending_review')
    )
      reporters.add(report.reporterUserId);
  }

  const distinctReporterCount = reporters.size;
  const thresholdReached = distinctReporterCount >= REPORT_THRESHOLD_DISTINCT_REPORTERS;
  if (!thresholdReached)
    return {
      distinctReporterCount,
      thresholdReached,
      outcome: 'below_threshold',
      transitionAccount: false,
    };
  if (input.activeEpisode)
    return {
      distinctReporterCount,
      thresholdReached,
      outcome: 'episode_already_active',
      transitionAccount: false,
    };
  if (
    input.targetAccountState === 'guest' ||
    input.targetAccountState === 'incomplete' ||
    input.targetAccountState === 'active'
  )
    return {
      distinctReporterCount,
      thresholdReached,
      outcome: 'create_restriction_episode',
      transitionAccount: true,
    };
  return {
    distinctReporterCount,
    thresholdReached,
    outcome: 'prioritize_without_transition',
    transitionAccount: false,
  };
}

const reviewTransitions: Readonly<
  Record<ModerationReviewStatus, ReadonlySet<ModerationReviewStatus>>
> = {
  pending: new Set(['in_review']),
  in_review: new Set(['dismissed', 'actioned']),
  dismissed: new Set(),
  actioned: new Set(),
};

export function canTransitionModerationReview(
  current: ModerationReviewStatus,
  next: ModerationReviewStatus,
): boolean {
  return reviewTransitions[current].has(next);
}

export function requiredPermissionForModerationAction(action: ModerationActionType): M7Permission {
  switch (action) {
    case 'restrict_user':
    case 'unrestrict_user':
      return 'restrict_users';
    case 'ban_user':
    case 'unban_user':
      return 'ban_users';
    case 'hide_photo':
    case 'restore_photo':
    case 'delete_photo':
      return 'moderate_photos';
    case 'create_internal_block':
    case 'remove_internal_block':
      return 'manage_internal_blocks';
  }
}

export type AdminPermissionDecision = Readonly<{
  allowed: boolean;
  reason?: 'admin_inactive' | 'permission_inactive' | 'permission_missing';
}>;

/** Roles are deliberately absent: authorization depends on an active exact permission grant. */
export function evaluateAdminPermission(
  input: Readonly<{
    adminActive: boolean;
    requiredPermission: M7Permission;
    activePermissions: ReadonlySet<M7Permission>;
    inactivePermissions?: ReadonlySet<M7Permission>;
  }>,
): AdminPermissionDecision {
  if (!input.adminActive) return { allowed: false, reason: 'admin_inactive' };
  if (input.inactivePermissions?.has(input.requiredPermission) === true)
    return { allowed: false, reason: 'permission_inactive' };
  if (!input.activePermissions.has(input.requiredPermission))
    return { allowed: false, reason: 'permission_missing' };
  return { allowed: true };
}

export function normalizeInternalBlockPair(
  firstUserId: string,
  secondUserId: string,
): readonly [string, string] {
  if (firstUserId.length === 0 || secondUserId.length === 0 || firstUserId === secondUserId)
    throw new ApplicationError('invalid_request', 'error.moderation.pair_invalid', 400);
  return firstUserId < secondUserId ? [firstUserId, secondUserId] : [secondUserId, firstUserId];
}

export function canUseSupport(accountState: AccountState): boolean {
  return accountState !== 'banned' && accountState !== 'deleted';
}

export function evaluateSupportMessageAdmission(unansweredUserMessages: number): Readonly<{
  allowed: boolean;
  remainingAfterAdmission: number;
}> {
  if (
    !Number.isInteger(unansweredUserMessages) ||
    unansweredUserMessages < 0 ||
    unansweredUserMessages > SUPPORT_UNANSWERED_LIMIT
  )
    throw new ApplicationError('moderation_state_invalid', 'error.support.state_invalid', 400);
  const allowed = unansweredUserMessages < SUPPORT_UNANSWERED_LIMIT;
  return {
    allowed,
    remainingAfterAdmission: allowed ? SUPPORT_UNANSWERED_LIMIT - unansweredUserMessages - 1 : 0,
  };
}

export function canSubmitAppeal(
  input: Readonly<{
    accountState: AccountState;
    currentBanHistoryId?: string;
    requestedBanHistoryId: string;
    existingAppeal: boolean;
  }>,
): boolean {
  return (
    input.accountState === 'banned' &&
    input.currentBanHistoryId !== undefined &&
    input.currentBanHistoryId === input.requestedBanHistoryId &&
    !input.existingAppeal
  );
}
