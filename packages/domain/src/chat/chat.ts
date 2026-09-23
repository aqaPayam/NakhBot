import { evaluateCapability } from '../access/capability-policy.js';
import type { FeatureUnlockStatus } from '../billing/billing.js';
import type { UserPairState } from '../discovery/discovery.js';
import { ApplicationError } from '../foundation.js';
import type { AccountState, ProfileCompletionStatus } from '../identity/account.js';

export const CHAT_TEXT_MAX_SCALARS = 1000;
export const CHAT_VISIBLE_MESSAGE_LIMIT = 50;
export const UNMATCH_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 8;
export const NOTIFICATION_RETRY_BASE_MS = 1000;
export const NOTIFICATION_RETRY_MAX_MS = 15 * 60 * 1000;

export const CHAT_MESSAGE_TYPES = [
  'predefined_question',
  'predefined_answer',
  'text',
  'system',
] as const;
export type ChatMessageType = (typeof CHAT_MESSAGE_TYPES)[number];

export type MatchStatus = 'active' | 'unmatched' | 'closed';
export type ChatStatus = 'active' | 'closed';

function validTime(value: Date, errorKey: string): number {
  const time = value.getTime();
  if (!Number.isFinite(time)) throw new ApplicationError('invalid_request', errorKey, 400);
  return time;
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

/** Produces the sole persisted representation for free chat text. */
export function normalizeChatText(text: string): string {
  if (containsLoneSurrogate(text))
    throw new ApplicationError('chat_text_invalid', 'error.chat.text_invalid', 400);
  const normalized = text.normalize('NFC').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > CHAT_TEXT_MAX_SCALARS ||
    containsUnsafeControlCharacter(normalized)
  )
    throw new ApplicationError('chat_text_invalid', 'error.chat.text_invalid', 400);
  return normalized;
}

export type ChatCapabilityFacts = Readonly<{
  accountState: AccountState;
  profileCompletion: ProfileCompletionStatus | null;
  visibilityEnabled: boolean;
  isParticipant: boolean;
  matchStatus: MatchStatus;
  chatStatus: ChatStatus;
  pairState?: UserPairState;
  featureUnlockStatus?: FeatureUnlockStatus;
  safetyWarningShown: boolean;
}>;

export type ChatCapabilities = Readonly<{
  canRead: boolean;
  canSendPredefined: boolean;
  canSendText: boolean;
  canUnmatch: boolean;
  textUnlocked: boolean;
  mustShowSafetyWarning: boolean;
}>;

/** Combines global Account capability with the current pair, Match, chat, and unlock scope. */
export function evaluateChatCapabilities(facts: ChatCapabilityFacts): ChatCapabilities {
  const activeScope =
    facts.isParticipant &&
    facts.matchStatus === 'active' &&
    facts.chatStatus === 'active' &&
    facts.pairState === 'matched';
  const accessContext = {
    accountState: facts.accountState,
    profileCompletion: facts.profileCompletion,
    visibilityEnabled: facts.visibilityEnabled,
    hasExistingMatch: activeScope,
    hasExistingChat: activeScope,
  };
  const canRead =
    activeScope && evaluateCapability(accessContext, 'read_existing_chat').allowed === true;
  const accountCanSend =
    activeScope && evaluateCapability(accessContext, 'send_chat_message').allowed === true;
  const textUnlocked = activeScope && facts.featureUnlockStatus === 'active';
  const mustShowSafetyWarning = accountCanSend && textUnlocked && !facts.safetyWarningShown;
  return {
    canRead,
    canSendPredefined: accountCanSend,
    canSendText: accountCanSend && textUnlocked && facts.safetyWarningShown,
    canUnmatch: canRead,
    textUnlocked,
    mustShowSafetyWarning,
  };
}

export function unmatchReportWindowExpiresAt(unmatchedAt: Date): Date {
  return new Date(
    validTime(unmatchedAt, 'error.chat.unmatch_time_invalid') + UNMATCH_REPORT_WINDOW_MS,
  );
}

export function isUnmatchReportWindowOpen(
  input: Readonly<{ unmatchedAt: Date; reportWindowExpiresAt: Date; now: Date }>,
): boolean {
  const unmatchedAt = validTime(input.unmatchedAt, 'error.chat.unmatch_time_invalid');
  const expiresAt = validTime(input.reportWindowExpiresAt, 'error.chat.unmatch_time_invalid');
  const now = validTime(input.now, 'error.chat.unmatch_time_invalid');
  if (expiresAt !== unmatchedAt + UNMATCH_REPORT_WINDOW_MS)
    throw new ApplicationError('chat_state_invalid', 'error.chat.unmatch_window_invalid', 400);
  return now >= unmatchedAt && now < expiresAt;
}

export type ChatCleanupCandidate = Readonly<{
  messageId: string;
  sequenceNumber: bigint;
  snapshotRequired: boolean;
  snapshotCaptured: boolean;
}>;

export type ChatCleanupPlan = Readonly<{
  visibleMessageIds: readonly string[];
  deleteMessageIds: readonly string[];
  deferredMessageIds: readonly string[];
  hasMore: boolean;
}>;

/** Plans a bounded delete from a complete newest-first session projection. */
export function planChatMessageCleanup(
  candidates: readonly ChatCleanupCandidate[],
  deleteBatchSize: number,
): ChatCleanupPlan {
  if (!Number.isInteger(deleteBatchSize) || deleteBatchSize < 1 || deleteBatchSize > 500)
    throw new ApplicationError('invalid_request', 'error.chat.cleanup_batch_invalid', 400);
  const messageIds = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (
      candidate.messageId.length === 0 ||
      candidate.sequenceNumber < 1n ||
      messageIds.has(candidate.messageId) ||
      (candidate.snapshotCaptured && !candidate.snapshotRequired) ||
      (index > 0 && candidates[index - 1]!.sequenceNumber <= candidate.sequenceNumber)
    )
      throw new ApplicationError('chat_state_invalid', 'error.chat.cleanup_state_invalid', 400);
    messageIds.add(candidate.messageId);
  }

  const visible = candidates.slice(0, CHAT_VISIBLE_MESSAGE_LIMIT);
  const older = candidates.slice(CHAT_VISIBLE_MESSAGE_LIMIT);
  const deferred = older.filter(
    (candidate) => candidate.snapshotRequired && !candidate.snapshotCaptured,
  );
  const deletable = older.filter(
    (candidate) => !candidate.snapshotRequired || candidate.snapshotCaptured,
  );
  const selected = deletable.slice(0, deleteBatchSize);
  return {
    visibleMessageIds: visible.map((candidate) => candidate.messageId),
    deleteMessageIds: selected.map((candidate) => candidate.messageId),
    deferredMessageIds: deferred.map((candidate) => candidate.messageId),
    hasMore: deletable.length > selected.length || deferred.length > 0,
  };
}

export const NOTIFICATION_PROVIDER_FAILURE_CODES = [
  'rate_limited',
  'provider_unavailable',
  'network_error',
  'bot_blocked',
  'recipient_unavailable',
  'provider_request_invalid',
  'ambiguous_result',
] as const;
export type NotificationProviderFailureCode = (typeof NOTIFICATION_PROVIDER_FAILURE_CODES)[number];

export type NotificationDeliveryFailurePlan =
  | Readonly<{
      status: 'failed_retryable';
      failureCode: NotificationProviderFailureCode;
      nextAttemptAt: Date;
      quarantine: false;
    }>
  | Readonly<{
      status: 'failed_terminal';
      failureCode: NotificationProviderFailureCode | 'retry_exhausted';
      quarantine: boolean;
    }>;

function providerFailureClass(
  code: NotificationProviderFailureCode,
): 'retryable' | 'terminal' | 'ambiguous' {
  switch (code) {
    case 'rate_limited':
    case 'provider_unavailable':
    case 'network_error':
      return 'retryable';
    case 'bot_blocked':
    case 'recipient_unavailable':
    case 'provider_request_invalid':
      return 'terminal';
    case 'ambiguous_result':
      return 'ambiguous';
  }
}

/** Maps one sanitized provider failure to a bounded retry or terminal/quarantine outcome. */
export function planNotificationDeliveryFailure(
  input: Readonly<{
    failureCode: NotificationProviderFailureCode;
    attemptNumber: number;
    now: Date;
    jitterRatio: number;
    retryAfterMs?: number;
  }>,
): NotificationDeliveryFailurePlan {
  const now = validTime(input.now, 'error.notification.delivery_time_invalid');
  if (
    !Number.isInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    input.attemptNumber > NOTIFICATION_DELIVERY_MAX_ATTEMPTS ||
    !Number.isFinite(input.jitterRatio) ||
    input.jitterRatio < 0 ||
    input.jitterRatio > 1 ||
    (input.retryAfterMs !== undefined &&
      (!Number.isInteger(input.retryAfterMs) || input.retryAfterMs < 0))
  )
    throw new ApplicationError(
      'notification_delivery_invalid',
      'error.notification.delivery_state_invalid',
      400,
    );

  const classification = providerFailureClass(input.failureCode);
  if (classification === 'ambiguous')
    return { status: 'failed_terminal', failureCode: input.failureCode, quarantine: true };
  if (classification === 'terminal')
    return { status: 'failed_terminal', failureCode: input.failureCode, quarantine: false };
  if (input.attemptNumber >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS)
    return { status: 'failed_terminal', failureCode: 'retry_exhausted', quarantine: false };

  const exponentialCeiling = Math.min(
    NOTIFICATION_RETRY_MAX_MS,
    NOTIFICATION_RETRY_BASE_MS * 2 ** (input.attemptNumber - 1),
  );
  const jitteredDelay = Math.max(1, Math.floor(exponentialCeiling * input.jitterRatio));
  const providerDelay =
    input.retryAfterMs === undefined ? 0 : Math.min(input.retryAfterMs, NOTIFICATION_RETRY_MAX_MS);
  return {
    status: 'failed_retryable',
    failureCode: input.failureCode,
    nextAttemptAt: new Date(now + Math.max(jitteredDelay, providerDelay)),
    quarantine: false,
  };
}
