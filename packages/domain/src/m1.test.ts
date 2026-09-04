import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATES,
  CAPABILITIES,
  assertAccountTransition,
  canTransitionAccountState,
  entryRouteFor,
  evaluateCapability,
  normalizeHumanText,
  parseGregorianBirthYear,
  validateProfileSelections,
  type AccountState,
  type Clock,
} from './index.js';

const allowedTransitions: Readonly<Record<AccountState, readonly AccountState[]>> = {
  guest: ['incomplete', 'restricted', 'banned', 'deleted'],
  incomplete: ['active', 'restricted', 'banned', 'deleted'],
  active: ['restricted', 'banned', 'deleted'],
  restricted: ['guest', 'incomplete', 'active', 'banned', 'deleted'],
  banned: ['guest', 'incomplete', 'active', 'restricted', 'deleted'],
  deleted: ['guest'],
};

describe('M1 account transition policy', () => {
  it('matches the complete canonical transition registry', () => {
    for (const from of ACCOUNT_STATES) {
      for (const to of ACCOUNT_STATES) {
        expect(canTransitionAccountState(from, to), `${from} -> ${to}`).toBe(
          allowedTransitions[from].includes(to),
        );
      }
    }
  });

  it('rejects a transition with a stable machine code and localization key', () => {
    expect(() => assertAccountTransition('active', 'incomplete')).toThrowError(
      expect.objectContaining({
        code: 'invalid_account_transition',
        message: 'error.account.invalid_transition',
      }),
    );
  });
});

describe('M1 centralized access policy', () => {
  it('routes every effective state from current facts', () => {
    expect(
      entryRouteFor({
        accountState: 'active',
        profileCompletion: 'invalid',
        visibilityEnabled: true,
      }),
    ).toBe('fix_profile');
    expect(
      entryRouteFor({
        accountState: 'active',
        profileCompletion: 'complete',
        visibilityEnabled: false,
      }),
    ).toBe('main_discovery_paused');
    expect(
      entryRouteFor({ accountState: 'banned', profileCompletion: null, visibilityEnabled: false }),
    ).toBe('ban_appeal');
  });

  it('implements the guest and incomplete access rows', () => {
    const guest = {
      accountState: 'guest',
      profileCompletion: null,
      visibilityEnabled: true,
    } as const;
    const incomplete = {
      accountState: 'incomplete',
      profileCompletion: 'incomplete',
      visibilityEnabled: true,
    } as const;

    expect(evaluateCapability(guest, 'guest_preview').allowed).toBe(true);
    expect(evaluateCapability(guest, 'start_discovery').allowed).toBe(false);
    expect(evaluateCapability(incomplete, 'continue_signup').allowed).toBe(true);
    expect(evaluateCapability(incomplete, 'start_paid_action').allowed).toBe(false);
  });

  it('proves ACC-003 active invalid routing and existing-chat exception', () => {
    const context = {
      accountState: 'active',
      profileCompletion: 'invalid',
      visibilityEnabled: true,
      hasExistingChat: true,
    } as const;

    expect(evaluateCapability(context, 'start_discovery')).toMatchObject({
      allowed: false,
      reasonCode: 'profile_incomplete',
      requiredRoute: 'fix_profile',
    });
    expect(evaluateCapability(context, 'send_chat_message').allowed).toBe(true);
    expect(evaluateCapability(context, 'unlock_existing_chat').allowed).toBe(true);
  });

  it('proves the M1 policy portion of ACC-004 visibility-off pending Nakh', () => {
    const context = {
      accountState: 'active',
      profileCompletion: 'complete',
      visibilityEnabled: false,
      hasExistingPendingNakh: true,
    } as const;

    expect(evaluateCapability(context, 'start_nakh').allowed).toBe(false);
    expect(evaluateCapability(context, 'settle_pending_nakh').allowed).toBe(true);
    expect(evaluateCapability(context, 'cancel_pending_nakh').allowed).toBe(true);
  });

  it('proves the M1 policy portions of ACC-005 and ACC-006', () => {
    const restricted = {
      accountState: 'restricted',
      profileCompletion: 'complete',
      visibilityEnabled: true,
      hasExistingChat: true,
    } as const;
    const banned = {
      accountState: 'banned',
      profileCompletion: 'complete',
      visibilityEnabled: true,
    } as const;

    expect(evaluateCapability(restricted, 'read_existing_chat').allowed).toBe(true);
    expect(evaluateCapability(restricted, 'send_chat_message')).toMatchObject({
      allowed: false,
      reasonCode: 'read_only',
    });
    expect(evaluateCapability(banned, 'create_support').allowed).toBe(false);
    expect(evaluateCapability(banned, 'create_appeal').allowed).toBe(true);
  });

  it('returns a decision for every account state and capability', () => {
    for (const accountState of ACCOUNT_STATES) {
      for (const capability of CAPABILITIES) {
        const result = evaluateCapability(
          {
            accountState,
            profileCompletion: accountState === 'active' ? 'complete' : null,
            visibilityEnabled: true,
          },
          capability,
        );
        expect(typeof result.allowed).toBe('boolean');
        expect(result.requiredRoute.length).toBeGreaterThan(0);
        if (result.allowed) expect(result.reasonCode).toBeUndefined();
        else expect(result.reasonCode).toBeTruthy();
      }
    }
  });
});

describe('M1 Profile validation', () => {
  const clock: Clock = { now: () => new Date('2026-09-04T00:00:00.000Z') };

  it('normalizes Unicode text and counts code points', () => {
    expect(normalizeHumanText('  Cafe\u0301  ', { path: 'name', minimum: 1, maximum: 4 })).toBe(
      'Café',
    );
    expect(() =>
      normalizeHumanText('a\u0000b', { path: 'name', minimum: 1, maximum: 32 }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('proves ACC-007 Persian and Arabic digit normalization', () => {
    expect(parseGregorianBirthYear('۲۰۰۰', clock)).toBe(2000);
    expect(parseGregorianBirthYear('٢٠٠٠', clock)).toBe(2000);
    expect(() => parseGregorianBirthYear('۱۴۰۰', clock)).toThrowError(
      expect.objectContaining({ code: 'invalid_birth_year' }),
    );
    expect(() => parseGregorianBirthYear('2009', clock)).toThrowError(
      expect.objectContaining({ code: 'underage' }),
    );
  });

  it('enforces distinct Profile selection cardinalities', () => {
    expect(
      validateProfileSelections({
        interestCodes: ['one', 'two', 'three', 'four', 'five'],
        languageCodes: ['en', 'fa'],
        personalityTagCodes: ['calm'],
      }),
    ).toEqual([]);
    expect(
      validateProfileSelections({
        interestCodes: ['one', 'one'],
        languageCodes: [],
        personalityTagCodes: [],
      }),
    ).toContainEqual({ path: 'interestCodes', code: 'error.profile.interests.invalid' });
  });
});
