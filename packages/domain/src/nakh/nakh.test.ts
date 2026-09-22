import { describe, expect, it } from 'vitest';

import { PAIR_STATES } from '../discovery/discovery.js';
import {
  ACCOUNT_STATES,
  PROFILE_COMPLETION_STATUSES,
  type AccountState,
  type ProfileCompletionStatus,
} from '../identity/account.js';

import {
  DELIVERED_NAKH_LIFETIME_MS,
  MAX_PENDING_NAKHES_PER_SENDER,
  MAX_PENDING_NAKH_REMINDERS,
  NAKH_CREDIT_COST,
  NAKH_TEXT_MAX_SCALARS,
  PENDING_NAKH_LIFETIME_MS,
  PENDING_NAKH_REMINDER_INTERVAL_MS,
  canAdmitPendingNakh,
  canTransitionNakh,
  canTransitionPendingNakh,
  deliveredNakhExpiresAt,
  isDelayedNakhDeliveryEligible,
  isPendingNakhReminderDue,
  pendingNakhExpiresAt,
  planPendingNakhFifoSettlement,
  validateNakhText,
} from './nakh.js';

const hour = 60 * 60 * 1000;
const base = new Date('2026-09-22T00:00:00.000Z');

describe('M5 Nakh policy', () => {
  it('validates Unicode scalar values without rewriting user prose', () => {
    const prose = '  Hello 🌳\nHow are you?  ';
    expect(validateNakhText(prose)).toBe(prose);
    expect(validateNakhText('🌳'.repeat(NAKH_TEXT_MAX_SCALARS))).toHaveLength(
      NAKH_TEXT_MAX_SCALARS * 2,
    );
    expect(() => validateNakhText('🌳'.repeat(NAKH_TEXT_MAX_SCALARS + 1))).toThrowError(
      expect.objectContaining({ code: 'nakh_text_invalid' }),
    );
    for (const invalid of ['', ' \n\t ', 'unsafe\u0000text', '\ud800'])
      expect(() => validateNakhText(invalid)).toThrowError(
        expect.objectContaining({ code: 'nakh_text_invalid' }),
      );
  });

  it('locks quota and both lifecycle transition graphs', () => {
    expect(NAKH_CREDIT_COST).toBe(2n);
    expect(canAdmitPendingNakh(MAX_PENDING_NAKHES_PER_SENDER - 1)).toBe(true);
    expect(canAdmitPendingNakh(MAX_PENDING_NAKHES_PER_SENDER)).toBe(false);
    expect(canTransitionPendingNakh('pending_payment', 'paid_and_sent')).toBe(true);
    expect(canTransitionPendingNakh('cancelled', 'paid_and_sent')).toBe(false);
    expect(canTransitionNakh('sent', 'seen')).toBe(true);
    expect(canTransitionNakh('seen', 'accepted')).toBe(true);
    expect(canTransitionNakh('accepted', 'closed')).toBe(false);
    expect(canTransitionNakh('rejected', 'accepted')).toBe(false);
  });

  it('uses independent exact fourteen-day clocks', () => {
    expect(pendingNakhExpiresAt(base).getTime() - base.getTime()).toBe(PENDING_NAKH_LIFETIME_MS);
    const sentAt = new Date(base.getTime() + 3 * hour);
    expect(deliveredNakhExpiresAt(sentAt).getTime() - sentAt.getTime()).toBe(
      DELIVERED_NAKH_LIFETIME_MS,
    );
    expect(deliveredNakhExpiresAt(sentAt)).not.toEqual(pendingNakhExpiresAt(base));
  });

  it('admits reminders only at six 48-hour boundaries before expiry', () => {
    const expiresAt = pendingNakhExpiresAt(base);
    const input = {
      status: 'pending_payment' as const,
      createdAt: base,
      expiresAt,
      reminderCount: 0,
    };
    expect(
      isPendingNakhReminderDue({
        ...input,
        now: new Date(base.getTime() + PENDING_NAKH_REMINDER_INTERVAL_MS - 1),
      }),
    ).toBe(false);
    expect(
      isPendingNakhReminderDue({
        ...input,
        now: new Date(base.getTime() + PENDING_NAKH_REMINDER_INTERVAL_MS),
      }),
    ).toBe(true);
    const lastReminderAt = new Date(base.getTime() + 12 * 24 * hour);
    expect(
      isPendingNakhReminderDue({
        ...input,
        reminderCount: MAX_PENDING_NAKH_REMINDERS,
        lastReminderAt,
        now: new Date(expiresAt.getTime() - 1),
      }),
    ).toBe(false);
    expect(isPendingNakhReminderDue({ ...input, status: 'cancelled', now: expiresAt })).toBe(false);
  });

  it('ACC-026 exhaustively ignores visibility and denies every unsafe delayed-delivery shape', () => {
    const participantShapes: ReadonlyArray<{
      accountState: AccountState;
      profileCompletion: ProfileCompletionStatus;
      visibilityEnabled: boolean;
    }> = ACCOUNT_STATES.flatMap((accountState) =>
      PROFILE_COMPLETION_STATUSES.flatMap((profileCompletion) =>
        [true, false].map((visibilityEnabled) => ({
          accountState,
          profileCompletion,
          visibilityEnabled,
        })),
      ),
    );
    const pairShapes = [undefined, ...PAIR_STATES] as const;
    let eligibleShapes = 0;

    for (const sender of participantShapes) {
      for (const receiver of participantShapes) {
        for (const pairState of pairShapes) {
          const expected =
            sender.accountState === 'active' &&
            receiver.accountState === 'active' &&
            sender.profileCompletion === 'complete' &&
            receiver.profileCompletion === 'complete' &&
            pairState === undefined;
          expect(
            isDelayedNakhDeliveryEligible({
              sender,
              receiver,
              ...(pairState === undefined ? {} : { pairState }),
            }),
            JSON.stringify({ sender, receiver, pairState }),
          ).toBe(expected);
          if (expected) eligibleShapes += 1;
        }
      }
    }

    // Both visibility flags vary independently; no other participant or pair shape is eligible.
    expect(eligibleShapes).toBe(4);
  });

  it('closes ineligible rows, spends FIFO, and stops without skipping', () => {
    const candidates = [
      { pendingNakhId: 'a', createdAt: base, eligible: false },
      { pendingNakhId: 'b', createdAt: new Date(base.getTime() + 1), eligible: true },
      { pendingNakhId: 'c', createdAt: new Date(base.getTime() + 2), eligible: true },
      { pendingNakhId: 'd', createdAt: new Date(base.getTime() + 3), eligible: false },
    ];
    expect(planPendingNakhFifoSettlement(candidates, 2n)).toEqual({
      steps: [
        { action: 'close_and_continue', pendingNakhId: 'a' },
        { action: 'deliver_and_continue', pendingNakhId: 'b', creditCost: 2n },
        { action: 'stop_insufficient_credits', pendingNakhId: 'c', requiredCredits: 2n },
      ],
      remainingCredits: 0n,
    });
  });

  it('preserves FIFO and never spends more than the supplied balance across many queues', () => {
    for (let length = 0; length <= 25; length += 1) {
      for (let balance = 0n; balance <= 8n; balance += 1n) {
        const candidates = Array.from({ length }, (_, index) => ({
          pendingNakhId: index.toString().padStart(3, '0'),
          createdAt: new Date(base.getTime() + index),
          eligible: index % 3 !== 0,
        }));
        const plan = planPendingNakhFifoSettlement(candidates, balance);
        const spent =
          plan.steps.filter((step) => step.action === 'deliver_and_continue').length * 2;
        expect(BigInt(spent) + plan.remainingCredits).toBe(balance);
        const stopIndex = plan.steps.findIndex(
          (step) => step.action === 'stop_insufficient_credits',
        );
        expect(stopIndex === -1 || stopIndex === plan.steps.length - 1).toBe(true);
      }
    }
  });

  it('rejects a queue that is not in canonical created-at/id order', () => {
    expect(() =>
      planPendingNakhFifoSettlement(
        [
          { pendingNakhId: 'b', createdAt: base, eligible: true },
          { pendingNakhId: 'a', createdAt: base, eligible: true },
        ],
        4n,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });
});
