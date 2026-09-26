import { describe, expect, it } from 'vitest';

import {
  ADMIN_REASON_MAX_SCALARS,
  APPEAL_TEXT_MAX_SCALARS,
  REPORT_TEXT_MAX_SCALARS,
  REPORT_THRESHOLD_WINDOW_MS,
  REVIEW_NOTE_MAX_SCALARS,
  SUPPORT_TEXT_MAX_SCALARS,
  USER_REPORT_LIMIT,
  USER_REPORT_WINDOW_MS,
  canSubmitAppeal,
  canTransitionModerationReview,
  canUseSupport,
  evaluateAdminPermission,
  evaluateReportThreshold,
  evaluateSupportMessageAdmission,
  evaluateUserReportAdmission,
  normalizeAdminReason,
  normalizeAppealText,
  normalizeInternalBlockPair,
  normalizeReportText,
  normalizeReviewNote,
  normalizeSupportText,
  requiredPermissionForModerationAction,
} from './moderation.js';

const now = new Date('2026-09-26T12:00:00.000Z');

describe('M7 moderation policy', () => {
  it('normalizes restricted text and enforces scalar limits', () => {
    expect(normalizeReportText('  Cafe\u0301  ')).toBe('Café');
    expect(normalizeReportText(' \n\t ')).toBeUndefined();
    expect(normalizeReportText()).toBeUndefined();
    expect(normalizeAdminReason('  reviewed evidence  ')).toBe('reviewed evidence');
    expect(normalizeReviewNote('   ')).toBeUndefined();
    expect(normalizeSupportText('  help me  ')).toBe('help me');
    expect(normalizeAppealText('  please review  ')).toBe('please review');

    for (const [normalize, maximum] of [
      [normalizeReportText, REPORT_TEXT_MAX_SCALARS],
      [normalizeAdminReason, ADMIN_REASON_MAX_SCALARS],
      [normalizeReviewNote, REVIEW_NOTE_MAX_SCALARS],
      [normalizeSupportText, SUPPORT_TEXT_MAX_SCALARS],
      [normalizeAppealText, APPEAL_TEXT_MAX_SCALARS],
    ] as const) {
      expect(normalize('🌳'.repeat(maximum))).toBe('🌳'.repeat(maximum));
      expect(() => normalize('🌳'.repeat(maximum + 1))).toThrow();
      expect(() => normalize('unsafe\u0000text')).toThrow();
      expect(() => normalize('\ud800')).toThrow();
    }
    expect(() => normalizeAdminReason('   ')).toThrowError(
      expect.objectContaining({ code: 'admin_reason_invalid' }),
    );
  });

  it('admits ten committed user reports in the exact rolling prior 24 hours', () => {
    const boundary = new Date(now.getTime() - USER_REPORT_WINDOW_MS);
    const recent = Array.from(
      { length: USER_REPORT_LIMIT },
      (_, index) => new Date(boundary.getTime() + index + 1),
    );
    expect(evaluateUserReportAdmission([boundary, ...recent.slice(0, 9)], now)).toEqual({
      allowed: true,
      committedInWindow: 9,
      remainingAfterAdmission: 0,
    });
    expect(evaluateUserReportAdmission(recent, now)).toEqual({
      allowed: false,
      committedInWindow: USER_REPORT_LIMIT,
      remainingAfterAdmission: 0,
    });
    expect(() => evaluateUserReportAdmission([new Date(now.getTime() + 1)], now)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('counts only distinct unresolved reporters inside the exact 30-day window', () => {
    const boundary = new Date(now.getTime() - REPORT_THRESHOLD_WINDOW_MS);
    const reports = [
      { reporterUserId: 'a', status: 'submitted' as const, submittedAt: now },
      { reporterUserId: 'a', status: 'pending_review' as const, submittedAt: now },
      { reporterUserId: 'b', status: 'submitted' as const, submittedAt: now },
      { reporterUserId: 'c', status: 'dismissed' as const, submittedAt: now },
      { reporterUserId: 'd', status: 'submitted' as const, submittedAt: boundary },
      { reporterUserId: 'e', status: 'pending_review' as const, submittedAt: now },
      { reporterUserId: 'f', status: 'submitted' as const, submittedAt: now },
      { reporterUserId: 'g', status: 'submitted' as const, submittedAt: now },
    ];
    expect(
      evaluateReportThreshold({
        reports,
        now,
        targetAccountState: 'active',
        activeEpisode: false,
      }),
    ).toEqual({
      distinctReporterCount: 5,
      thresholdReached: true,
      outcome: 'create_restriction_episode',
      transitionAccount: true,
    });
  });

  it('never plans a second transition or automatic ban', () => {
    const reports = Array.from({ length: 5 }, (_, index) => ({
      reporterUserId: `reporter-${index}`,
      status: 'submitted' as const,
      submittedAt: now,
    }));
    expect(
      evaluateReportThreshold({
        reports,
        now,
        targetAccountState: 'incomplete',
        activeEpisode: false,
      }),
    ).toMatchObject({ outcome: 'create_restriction_episode', transitionAccount: true });
    expect(
      evaluateReportThreshold({
        reports,
        now,
        targetAccountState: 'restricted',
        activeEpisode: true,
      }),
    ).toMatchObject({ outcome: 'episode_already_active', transitionAccount: false });
    expect(
      evaluateReportThreshold({
        reports,
        now,
        targetAccountState: 'banned',
        activeEpisode: false,
      }),
    ).toMatchObject({ outcome: 'prioritize_without_transition', transitionAccount: false });
  });

  it('locks review transitions and exact action permissions', () => {
    expect(canTransitionModerationReview('pending', 'in_review')).toBe(true);
    expect(canTransitionModerationReview('in_review', 'dismissed')).toBe(true);
    expect(canTransitionModerationReview('in_review', 'actioned')).toBe(true);
    expect(canTransitionModerationReview('pending', 'actioned')).toBe(false);
    expect(canTransitionModerationReview('dismissed', 'in_review')).toBe(false);
    expect(requiredPermissionForModerationAction('ban_user')).toBe('ban_users');
    expect(requiredPermissionForModerationAction('hide_photo')).toBe('moderate_photos');
    expect(requiredPermissionForModerationAction('create_internal_block')).toBe(
      'manage_internal_blocks',
    );
  });

  it('authorizes only active admins with an active exact permission', () => {
    const permissions = new Set(['view_reports', 'ban_users'] as const);
    expect(
      evaluateAdminPermission({
        adminActive: true,
        requiredPermission: 'ban_users',
        activePermissions: permissions,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateAdminPermission({
        adminActive: true,
        requiredPermission: 'restrict_users',
        activePermissions: permissions,
      }),
    ).toEqual({ allowed: false, reason: 'permission_missing' });
    expect(
      evaluateAdminPermission({
        adminActive: false,
        requiredPermission: 'ban_users',
        activePermissions: permissions,
      }),
    ).toEqual({ allowed: false, reason: 'admin_inactive' });
    expect(
      evaluateAdminPermission({
        adminActive: true,
        requiredPermission: 'ban_users',
        activePermissions: permissions,
        inactivePermissions: new Set(['ban_users']),
      }),
    ).toEqual({ allowed: false, reason: 'permission_inactive' });
  });

  it('normalizes internal pairs without allowing self-blocks', () => {
    expect(normalizeInternalBlockPair('user-b', 'user-a')).toEqual(['user-a', 'user-b']);
    expect(() => normalizeInternalBlockPair('user-a', 'user-a')).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('limits support to two unanswered messages and resets after a reply projection', () => {
    expect(canUseSupport('active')).toBe(true);
    expect(canUseSupport('restricted')).toBe(true);
    expect(canUseSupport('banned')).toBe(false);
    expect(canUseSupport('deleted')).toBe(false);
    expect(evaluateSupportMessageAdmission(0)).toEqual({
      allowed: true,
      remainingAfterAdmission: 1,
    });
    expect(evaluateSupportMessageAdmission(1)).toEqual({
      allowed: true,
      remainingAfterAdmission: 0,
    });
    expect(evaluateSupportMessageAdmission(2)).toEqual({
      allowed: false,
      remainingAfterAdmission: 0,
    });
  });

  it('allows one appeal only for the current ban history event', () => {
    const input = {
      accountState: 'banned' as const,
      currentBanHistoryId: 'ban-2',
      requestedBanHistoryId: 'ban-2',
      existingAppeal: false,
    };
    expect(canSubmitAppeal(input)).toBe(true);
    expect(canSubmitAppeal({ ...input, existingAppeal: true })).toBe(false);
    expect(canSubmitAppeal({ ...input, requestedBanHistoryId: 'ban-1' })).toBe(false);
    expect(canSubmitAppeal({ ...input, accountState: 'active' })).toBe(false);
  });
});
