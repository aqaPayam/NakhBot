import { ApplicationError } from '../foundation.js';

export const CREDIT_PACKAGE_DEFINITIONS = [
  { code: 'starter', credits: 10n, stars: 10n, badge: undefined, displayOrder: 1 },
  { code: 'plus', credits: 25n, stars: 20n, badge: 'popular', displayOrder: 2 },
  { code: 'best_value', credits: 50n, stars: 35n, badge: 'best_value', displayOrder: 3 },
  { code: 'ultimate', credits: 100n, stars: 60n, badge: 'best_value', displayOrder: 4 },
] as const;

export type CreditPackageCode = (typeof CREDIT_PACKAGE_DEFINITIONS)[number]['code'];
export type PaidActionReason = 'unlock_liked_by_profile' | 'unlock_chat';
export type FeatureUnlockType = 'liked_by_profile_unlock' | 'chat_unlock';
export type FeatureUnlockStatus = 'active' | 'revoked' | 'expired';
export type PendingPaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired';
export type PaymentStatus = PendingPaymentStatus | 'refunded';
export type CreditTransactionType =
  | 'purchase'
  | 'spend_nakh'
  | 'spend_chat_unlock'
  | 'spend_liked_by_unlock'
  | 'refund'
  | 'admin_adjustment';

export const PAID_ACTION_PRICES: Readonly<
  Record<PaidActionReason, Readonly<{ credits: bigint; stars: bigint }>>
> = {
  unlock_liked_by_profile: { credits: 4n, stars: 4n },
  unlock_chat: { credits: 4n, stars: 4n },
};

export const PROVIDER_ATTEMPT_LIMIT = 10;
export const PROVIDER_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const FUNDING_INTENT_TTL_MS = 15 * 60 * 1000;

export function getCreditPackageDefinition(
  code: string,
): (typeof CREDIT_PACKAGE_DEFINITIONS)[number] {
  const definition = CREDIT_PACKAGE_DEFINITIONS.find((candidate) => candidate.code === code);
  if (definition === undefined)
    throw new ApplicationError('package_unavailable', 'error.billing.package_unavailable', 409);
  return definition;
}

export function getPaidActionPrice(reason: PaidActionReason, funding: 'credits' | 'stars'): bigint {
  return PAID_ACTION_PRICES[reason][funding];
}

export function calculateCreditBalance(
  input: Readonly<{
    transactionType: CreditTransactionType;
    balanceBefore: bigint;
    amount: bigint;
  }>,
): bigint {
  const { transactionType, balanceBefore, amount } = input;
  if (balanceBefore < 0n || amount === 0n)
    throw new ApplicationError(
      'invalid_credit_transaction',
      'error.billing.credit_transaction_invalid',
      400,
    );

  const positive = transactionType === 'purchase' || transactionType === 'refund';
  const negative = transactionType.startsWith('spend_');
  if ((positive && amount < 0n) || (negative && amount > 0n))
    throw new ApplicationError(
      'invalid_credit_transaction',
      'error.billing.credit_transaction_invalid',
      400,
    );

  const balanceAfter = balanceBefore + amount;
  if (balanceAfter < 0n)
    throw new ApplicationError('insufficient_credits', 'error.billing.insufficient_credits', 409);
  return balanceAfter;
}

export type FeatureUnlockProof = Readonly<{
  type: FeatureUnlockType;
  likeId?: string;
  matchId?: string;
  paymentRecordId?: string;
  creditTransactionId?: string;
  expiresAt?: Date;
}>;

export function assertMvpFeatureUnlockProof(proof: FeatureUnlockProof): void {
  const likeScoped = proof.likeId !== undefined && proof.matchId === undefined;
  const matchScoped = proof.matchId !== undefined && proof.likeId === undefined;
  const paymentFunded =
    proof.paymentRecordId !== undefined && proof.creditTransactionId === undefined;
  const creditFunded =
    proof.creditTransactionId !== undefined && proof.paymentRecordId === undefined;
  if (
    (proof.type === 'liked_by_profile_unlock' && !likeScoped) ||
    (proof.type === 'chat_unlock' && !matchScoped) ||
    (!paymentFunded && !creditFunded) ||
    proof.expiresAt !== undefined
  )
    throw new ApplicationError('invalid_unlock', 'error.billing.unlock_invalid', 400);
}

export function isFeatureUnlockEffective(
  input: Readonly<{
    type: FeatureUnlockType;
    status: FeatureUnlockStatus;
    likeActionable?: boolean;
    matchActive?: boolean;
  }>,
): boolean {
  if (input.status !== 'active') return false;
  return input.type === 'liked_by_profile_unlock'
    ? input.likeActionable === true
    : input.matchActive === true;
}

export function canTransitionPendingPayment(
  current: PendingPaymentStatus,
  next: PendingPaymentStatus,
): boolean {
  return current === 'pending' && next !== 'pending';
}

export function canTransitionPayment(current: PaymentStatus, next: PaymentStatus): boolean {
  if (current === 'pending') return next !== 'pending' && next !== 'refunded';
  return current === 'paid' && next === 'refunded';
}

export function assertProviderAttemptAllowed(priorAttemptTimes: readonly Date[], now: Date): void {
  const currentTime = now.getTime();
  if (!Number.isFinite(currentTime))
    throw new ApplicationError('invalid_request', 'error.billing.time_invalid', 400);
  const cutoff = currentTime - PROVIDER_ATTEMPT_WINDOW_MS;
  const attemptsInWindow = priorAttemptTimes.filter((attempt) => {
    const time = attempt.getTime();
    if (!Number.isFinite(time) || time > currentTime)
      throw new ApplicationError('invalid_request', 'error.billing.time_invalid', 400);
    return time > cutoff;
  }).length;
  if (attemptsInWindow >= PROVIDER_ATTEMPT_LIMIT)
    throw new ApplicationError('payment_attempt_limit', 'error.billing.attempt_limit', 429);
}
