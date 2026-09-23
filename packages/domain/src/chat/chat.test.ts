import { describe, expect, it } from 'vitest';

import {
  CHAT_TEXT_MAX_SCALARS,
  CHAT_VISIBLE_MESSAGE_LIMIT,
  NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_MAX_MS,
  UNMATCH_REPORT_WINDOW_MS,
  evaluateChatCapabilities,
  isUnmatchReportWindowOpen,
  normalizeChatText,
  planChatMessageCleanup,
  planNotificationDeliveryFailure,
  unmatchReportWindowExpiresAt,
} from './chat.js';

const base = new Date('2026-09-24T00:00:00.000Z');

describe('M6 chat policy', () => {
  it('normalizes line endings, whitespace, and Unicode before enforcing scalar length', () => {
    expect(normalizeChatText('  Cafe\u0301\r\nhello  ')).toBe('Café\nhello');
    expect(normalizeChatText('🌳'.repeat(CHAT_TEXT_MAX_SCALARS))).toBe(
      '🌳'.repeat(CHAT_TEXT_MAX_SCALARS),
    );
    for (const invalid of [
      '',
      ' \n\t ',
      '🌳'.repeat(CHAT_TEXT_MAX_SCALARS + 1),
      'unsafe\u0000text',
      '\ud800',
    ])
      expect(() => normalizeChatText(invalid)).toThrowError(
        expect.objectContaining({ code: 'chat_text_invalid' }),
      );
  });

  it('keeps restricted chat read-only and gates free text on unlock plus warning', () => {
    const active = {
      accountState: 'active' as const,
      profileCompletion: 'complete' as const,
      visibilityEnabled: false,
      isParticipant: true,
      matchStatus: 'active' as const,
      chatStatus: 'active' as const,
      pairState: 'matched' as const,
      featureUnlockStatus: 'active' as const,
      safetyWarningShown: false,
    };
    expect(evaluateChatCapabilities(active)).toEqual({
      canRead: true,
      canSendPredefined: true,
      canSendText: false,
      canUnmatch: true,
      textUnlocked: true,
      mustShowSafetyWarning: true,
    });
    expect(evaluateChatCapabilities({ ...active, safetyWarningShown: true }).canSendText).toBe(
      true,
    );
    expect(
      evaluateChatCapabilities({
        ...active,
        accountState: 'restricted',
        safetyWarningShown: true,
      }),
    ).toMatchObject({ canRead: true, canSendPredefined: false, canSendText: false });
    expect(evaluateChatCapabilities({ ...active, featureUnlockStatus: 'revoked' })).toMatchObject({
      canSendPredefined: true,
      canSendText: false,
      textUnlocked: false,
    });
  });

  it('denies every capability when membership or active pair scope is absent', () => {
    const baseFacts = {
      accountState: 'active' as const,
      profileCompletion: 'invalid' as const,
      visibilityEnabled: true,
      isParticipant: true,
      matchStatus: 'active' as const,
      chatStatus: 'active' as const,
      pairState: 'matched' as const,
      featureUnlockStatus: 'active' as const,
      safetyWarningShown: true,
    };
    for (const facts of [
      { ...baseFacts, isParticipant: false },
      { ...baseFacts, matchStatus: 'unmatched' as const },
      { ...baseFacts, chatStatus: 'closed' as const },
      { ...baseFacts, pairState: 'blocked' as const },
    ])
      expect(evaluateChatCapabilities(facts)).toEqual({
        canRead: false,
        canSendPredefined: false,
        canSendText: false,
        canUnmatch: false,
        textUnlocked: false,
        mustShowSafetyWarning: false,
      });
  });

  it('opens the Unmatch report window for exactly 24 hours', () => {
    const expiresAt = unmatchReportWindowExpiresAt(base);
    expect(expiresAt.getTime() - base.getTime()).toBe(UNMATCH_REPORT_WINDOW_MS);
    expect(
      isUnmatchReportWindowOpen({ unmatchedAt: base, reportWindowExpiresAt: expiresAt, now: base }),
    ).toBe(true);
    expect(
      isUnmatchReportWindowOpen({
        unmatchedAt: base,
        reportWindowExpiresAt: expiresAt,
        now: new Date(expiresAt.getTime() - 1),
      }),
    ).toBe(true);
    expect(
      isUnmatchReportWindowOpen({
        unmatchedAt: base,
        reportWindowExpiresAt: expiresAt,
        now: expiresAt,
      }),
    ).toBe(false);
  });

  it('retains 50 visible messages and defers deletion until required snapshots exist', () => {
    const candidates = Array.from({ length: CHAT_VISIBLE_MESSAGE_LIMIT + 5 }, (_, index) => ({
      messageId: `message-${index}`,
      sequenceNumber: BigInt(CHAT_VISIBLE_MESSAGE_LIMIT + 5 - index),
      snapshotRequired: index === CHAT_VISIBLE_MESSAGE_LIMIT + 1,
      snapshotCaptured: false,
    }));
    candidates[CHAT_VISIBLE_MESSAGE_LIMIT + 3] = {
      ...candidates[CHAT_VISIBLE_MESSAGE_LIMIT + 3]!,
      snapshotRequired: true,
      snapshotCaptured: true,
    };
    const plan = planChatMessageCleanup(candidates, 2);
    expect(plan.visibleMessageIds).toHaveLength(CHAT_VISIBLE_MESSAGE_LIMIT);
    expect(plan.deleteMessageIds).toEqual(['message-50', 'message-52']);
    expect(plan.deferredMessageIds).toEqual(['message-51']);
    expect(plan.hasMore).toBe(true);
  });

  it('rejects malformed cleanup order and contradictory snapshot state', () => {
    expect(() =>
      planChatMessageCleanup(
        [
          {
            messageId: 'a',
            sequenceNumber: 1n,
            snapshotRequired: false,
            snapshotCaptured: false,
          },
          {
            messageId: 'b',
            sequenceNumber: 2n,
            snapshotRequired: false,
            snapshotCaptured: false,
          },
        ],
        10,
      ),
    ).toThrowError(expect.objectContaining({ code: 'chat_state_invalid' }));
    expect(() =>
      planChatMessageCleanup(
        [
          {
            messageId: 'a',
            sequenceNumber: 1n,
            snapshotRequired: false,
            snapshotCaptured: true,
          },
        ],
        10,
      ),
    ).toThrowError(expect.objectContaining({ code: 'chat_state_invalid' }));
  });

  it('plans bounded provider retries and quarantines ambiguous outcomes', () => {
    expect(
      planNotificationDeliveryFailure({
        failureCode: 'rate_limited',
        attemptNumber: 2,
        now: base,
        jitterRatio: 0.5,
        retryAfterMs: 10_000,
      }),
    ).toEqual({
      status: 'failed_retryable',
      failureCode: 'rate_limited',
      nextAttemptAt: new Date(base.getTime() + 10_000),
      quarantine: false,
    });
    expect(
      planNotificationDeliveryFailure({
        failureCode: 'rate_limited',
        attemptNumber: 2,
        now: base,
        jitterRatio: 1,
        retryAfterMs: NOTIFICATION_RETRY_MAX_MS * 2,
      }),
    ).toMatchObject({ nextAttemptAt: new Date(base.getTime() + NOTIFICATION_RETRY_MAX_MS) });
    expect(
      planNotificationDeliveryFailure({
        failureCode: 'network_error',
        attemptNumber: NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
        now: base,
        jitterRatio: 1,
      }),
    ).toEqual({
      status: 'failed_terminal',
      failureCode: 'retry_exhausted',
      quarantine: false,
    });
    expect(
      planNotificationDeliveryFailure({
        failureCode: 'ambiguous_result',
        attemptNumber: 1,
        now: base,
        jitterRatio: 1,
      }),
    ).toEqual({
      status: 'failed_terminal',
      failureCode: 'ambiguous_result',
      quarantine: true,
    });
    expect(
      planNotificationDeliveryFailure({
        failureCode: 'bot_blocked',
        attemptNumber: 1,
        now: base,
        jitterRatio: 1,
      }),
    ).toEqual({
      status: 'failed_terminal',
      failureCode: 'bot_blocked',
      quarantine: false,
    });
  });
});
