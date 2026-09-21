import { describe, expect, it } from 'vitest';

import {
  CREDIT_PACKAGE_DEFINITIONS,
  assertMvpFeatureUnlockProof,
  assertProviderAttemptAllowed,
  calculateCreditBalance,
  canTransitionPayment,
  canTransitionPendingPayment,
  getCreditPackageDefinition,
  getPaidActionPrice,
  isFeatureUnlockEffective,
} from './billing.js';

describe('M4 billing and entitlement policy', () => {
  it('locks the four package snapshots and paid action prices', () => {
    expect(CREDIT_PACKAGE_DEFINITIONS).toEqual([
      { code: 'starter', credits: 10n, stars: 10n, badge: undefined, displayOrder: 1 },
      { code: 'plus', credits: 25n, stars: 20n, badge: 'popular', displayOrder: 2 },
      { code: 'best_value', credits: 50n, stars: 35n, badge: 'best_value', displayOrder: 3 },
      { code: 'ultimate', credits: 100n, stars: 60n, badge: 'best_value', displayOrder: 4 },
    ]);
    expect(getCreditPackageDefinition('best_value').credits).toBe(50n);
    expect(getPaidActionPrice('unlock_liked_by_profile', 'credits')).toBe(4n);
    expect(getPaidActionPrice('unlock_chat', 'stars')).toBe(4n);
    expect(() => getCreditPackageDefinition('forged')).toThrowError(
      expect.objectContaining({ code: 'package_unavailable' }),
    );
  });

  it('calculates a signed continuous ledger without permitting negative balance', () => {
    expect(
      calculateCreditBalance({ transactionType: 'purchase', balanceBefore: 0n, amount: 10n }),
    ).toBe(10n);
    expect(
      calculateCreditBalance({
        transactionType: 'spend_chat_unlock',
        balanceBefore: 10n,
        amount: -4n,
      }),
    ).toBe(6n);
    expect(() =>
      calculateCreditBalance({
        transactionType: 'spend_liked_by_unlock',
        balanceBefore: 3n,
        amount: -4n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'insufficient_credits' }));
    expect(() =>
      calculateCreditBalance({ transactionType: 'purchase', balanceBefore: 0n, amount: -1n }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_credit_transaction' }));
  });

  it('requires exactly one matching scope, one funding proof and no MVP expiry', () => {
    expect(() =>
      assertMvpFeatureUnlockProof({
        type: 'liked_by_profile_unlock',
        likeId: 'like',
        creditTransactionId: 'transaction',
      }),
    ).not.toThrow();
    expect(() =>
      assertMvpFeatureUnlockProof({
        type: 'chat_unlock',
        matchId: 'match',
        paymentRecordId: 'payment',
      }),
    ).not.toThrow();
    expect(() =>
      assertMvpFeatureUnlockProof({
        type: 'chat_unlock',
        likeId: 'like',
        paymentRecordId: 'payment',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_unlock' }));
    expect(() =>
      assertMvpFeatureUnlockProof({
        type: 'chat_unlock',
        matchId: 'match',
        paymentRecordId: 'payment',
        creditTransactionId: 'transaction',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_unlock' }));
  });

  it('derives access from both the grant and its live scope', () => {
    expect(
      isFeatureUnlockEffective({
        type: 'liked_by_profile_unlock',
        status: 'active',
        likeActionable: true,
      }),
    ).toBe(true);
    expect(
      isFeatureUnlockEffective({
        type: 'liked_by_profile_unlock',
        status: 'active',
        likeActionable: false,
      }),
    ).toBe(false);
    expect(
      isFeatureUnlockEffective({ type: 'chat_unlock', status: 'active', matchActive: true }),
    ).toBe(true);
    expect(
      isFeatureUnlockEffective({ type: 'chat_unlock', status: 'revoked', matchActive: true }),
    ).toBe(false);
  });

  it('permits only canonical payment state transitions', () => {
    expect(canTransitionPendingPayment('pending', 'paid')).toBe(true);
    expect(canTransitionPendingPayment('paid', 'failed')).toBe(false);
    expect(canTransitionPayment('pending', 'paid')).toBe(true);
    expect(canTransitionPayment('pending', 'refunded')).toBe(false);
    expect(canTransitionPayment('paid', 'refunded')).toBe(true);
    expect(canTransitionPayment('failed', 'paid')).toBe(false);
  });

  it('admits only ten provider attempts in a rolling ten-minute window', () => {
    const now = new Date('2026-09-21T12:00:00.000Z');
    const admitted = Array.from(
      { length: 9 },
      (_, index) => new Date(now.getTime() - (index + 1) * 30_000),
    );
    expect(() => assertProviderAttemptAllowed(admitted, now)).not.toThrow();
    expect(() =>
      assertProviderAttemptAllowed([...admitted, new Date(now.getTime() - 9 * 60_000)], now),
    ).toThrowError(expect.objectContaining({ code: 'payment_attempt_limit' }));
    expect(() =>
      assertProviderAttemptAllowed([...admitted, new Date(now.getTime() - 10 * 60_000)], now),
    ).not.toThrow();
  });
});
