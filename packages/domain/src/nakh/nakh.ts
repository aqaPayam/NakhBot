import type { UserPairState } from '../discovery/discovery.js';
import { ApplicationError } from '../foundation.js';
import type { AccountState, ProfileCompletionStatus } from '../identity/account.js';

export const PENDING_NAKH_STATUSES = [
  'pending_payment',
  'paid_and_sent',
  'cancelled',
  'expired',
  'closed_by_system',
] as const;
export type PendingNakhStatus = (typeof PENDING_NAKH_STATUSES)[number];

export const PENDING_NAKH_CANCEL_RESOLUTIONS = [
  'converted_to_like',
  'converted_to_not_interested',
] as const;
export type PendingNakhCancelResolution = (typeof PENDING_NAKH_CANCEL_RESOLUTIONS)[number];

export const NAKH_STATUSES = ['sent', 'seen', 'accepted', 'rejected', 'expired', 'closed'] as const;
export type NakhStatus = (typeof NAKH_STATUSES)[number];

export const NAKH_RECEIVER_ACTION_TYPES = ['view_profile', 'accept', 'reject', 'report'] as const;
export type NakhReceiverActionType = (typeof NAKH_RECEIVER_ACTION_TYPES)[number];

export const NAKH_CREDIT_COST = 2n;
export const NAKH_STARS_COST = 2n;
export const NAKH_TEXT_MAX_SCALARS = 240;
export const MAX_PENDING_NAKHES_PER_SENDER = 5;
export const PENDING_NAKH_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const DELIVERED_NAKH_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const PENDING_NAKH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;
export const MAX_PENDING_NAKH_REMINDERS = 6;

function timestamp(value: Date): number {
  const result = value.getTime();
  if (!Number.isFinite(result))
    throw new ApplicationError('invalid_request', 'error.nakh.time_invalid', 400);
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

/** Returns the original prose unchanged after validating the authoritative scalar-value limit. */
export function validateNakhText(text: string): string {
  if (
    text.trim().length === 0 ||
    [...text].length > NAKH_TEXT_MAX_SCALARS ||
    containsUnsafeControlCharacter(text) ||
    containsLoneSurrogate(text)
  )
    throw new ApplicationError('nakh_text_invalid', 'error.nakh.text_invalid', 400);
  return text;
}

export function pendingNakhExpiresAt(createdAt: Date): Date {
  return new Date(timestamp(createdAt) + PENDING_NAKH_LIFETIME_MS);
}

export function deliveredNakhExpiresAt(sentAt: Date): Date {
  return new Date(timestamp(sentAt) + DELIVERED_NAKH_LIFETIME_MS);
}

export function canAdmitPendingNakh(currentPendingCount: number): boolean {
  if (
    !Number.isInteger(currentPendingCount) ||
    currentPendingCount < 0 ||
    currentPendingCount > MAX_PENDING_NAKHES_PER_SENDER
  )
    throw new ApplicationError('invalid_request', 'error.nakh.pending_count_invalid', 400);
  return currentPendingCount < MAX_PENDING_NAKHES_PER_SENDER;
}

export function canTransitionPendingNakh(
  current: PendingNakhStatus,
  next: PendingNakhStatus,
): boolean {
  return current === 'pending_payment' && next !== 'pending_payment';
}

export function canTransitionNakh(current: NakhStatus, next: NakhStatus): boolean {
  if (current === 'sent') return next !== 'sent';
  return current === 'seen' && !['sent', 'seen'].includes(next);
}

export type DelayedNakhParticipant = Readonly<{
  accountState: AccountState;
  profileCompletion: ProfileCompletionStatus;
  visibilityEnabled: boolean;
}>;

/** Visibility is deliberately ignored for an already-authorized delayed delivery. */
export function isDelayedNakhDeliveryEligible(
  input: Readonly<{
    sender: DelayedNakhParticipant;
    receiver: DelayedNakhParticipant;
    pairState?: UserPairState;
  }>,
): boolean {
  return (
    input.sender.accountState === 'active' &&
    input.receiver.accountState === 'active' &&
    input.sender.profileCompletion === 'complete' &&
    input.receiver.profileCompletion === 'complete' &&
    input.pairState === undefined
  );
}

export function isPendingNakhReminderDue(
  input: Readonly<{
    status: PendingNakhStatus;
    createdAt: Date;
    expiresAt: Date;
    reminderCount: number;
    lastReminderAt?: Date;
    now: Date;
  }>,
): boolean {
  const createdAt = timestamp(input.createdAt);
  const expiresAt = timestamp(input.expiresAt);
  const now = timestamp(input.now);
  if (
    !Number.isInteger(input.reminderCount) ||
    input.reminderCount < 0 ||
    input.reminderCount > MAX_PENDING_NAKH_REMINDERS ||
    expiresAt !== createdAt + PENDING_NAKH_LIFETIME_MS ||
    (input.reminderCount === 0) !== (input.lastReminderAt === undefined)
  )
    throw new ApplicationError('invalid_request', 'error.nakh.reminder_state_invalid', 400);
  if (input.status !== 'pending_payment' || input.reminderCount >= MAX_PENDING_NAKH_REMINDERS)
    return false;
  const baseline = input.lastReminderAt === undefined ? createdAt : timestamp(input.lastReminderAt);
  if (baseline < createdAt || baseline >= expiresAt)
    throw new ApplicationError('invalid_request', 'error.nakh.reminder_state_invalid', 400);
  return now < expiresAt && now >= baseline + PENDING_NAKH_REMINDER_INTERVAL_MS;
}

export type PendingNakhSettlementCandidate = Readonly<{
  pendingNakhId: string;
  createdAt: Date;
  eligible: boolean;
}>;

export type PendingNakhSettlementStep =
  | Readonly<{ action: 'close_and_continue'; pendingNakhId: string }>
  | Readonly<{ action: 'deliver_and_continue'; pendingNakhId: string; creditCost: bigint }>
  | Readonly<{
      action: 'stop_insufficient_credits';
      pendingNakhId: string;
      requiredCredits: bigint;
    }>;

function compareCandidateOrder(
  left: PendingNakhSettlementCandidate,
  right: PendingNakhSettlementCandidate,
): number {
  const timeDifference = timestamp(left.createdAt) - timestamp(right.createdAt);
  return timeDifference === 0
    ? left.pendingNakhId.localeCompare(right.pendingNakhId)
    : timeDifference;
}

/** Plans one serialized FIFO pass. The caller still owns locks and atomic persistence. */
export function planPendingNakhFifoSettlement(
  candidates: readonly PendingNakhSettlementCandidate[],
  availableCredits: bigint,
): Readonly<{ steps: readonly PendingNakhSettlementStep[]; remainingCredits: bigint }> {
  if (availableCredits < 0n)
    throw new ApplicationError('invalid_request', 'error.nakh.balance_invalid', 400);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (candidate.pendingNakhId.length === 0) {
      throw new ApplicationError('invalid_request', 'error.nakh.fifo_order_invalid', 400);
    }
    timestamp(candidate.createdAt);
    if (index > 0 && compareCandidateOrder(candidates[index - 1]!, candidate) >= 0)
      throw new ApplicationError('invalid_request', 'error.nakh.fifo_order_invalid', 400);
  }

  let remainingCredits = availableCredits;
  const steps: PendingNakhSettlementStep[] = [];
  for (const candidate of candidates) {
    if (!candidate.eligible) {
      steps.push({ action: 'close_and_continue', pendingNakhId: candidate.pendingNakhId });
      continue;
    }
    if (remainingCredits < NAKH_CREDIT_COST) {
      steps.push({
        action: 'stop_insufficient_credits',
        pendingNakhId: candidate.pendingNakhId,
        requiredCredits: NAKH_CREDIT_COST,
      });
      break;
    }
    remainingCredits -= NAKH_CREDIT_COST;
    steps.push({
      action: 'deliver_and_continue',
      pendingNakhId: candidate.pendingNakhId,
      creditCost: NAKH_CREDIT_COST,
    });
  }
  return { steps, remainingCredits };
}
