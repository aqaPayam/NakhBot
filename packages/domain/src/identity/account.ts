import { ApplicationError } from '../foundation.js';

export const ACCOUNT_STATES = [
  'guest',
  'incomplete',
  'active',
  'restricted',
  'banned',
  'deleted',
] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

export const SIGNUP_STEPS = [
  'age_confirmation',
  'name',
  'birth_year',
  'gender',
  'relationship_gender_preference',
  'interests',
  'location',
  'relationship_goal',
  'primary_photo',
  'additional_photos',
  'highlight',
  'optional_details',
  'confirm_profile',
  'completed',
] as const;

export type SignupStep = (typeof SIGNUP_STEPS)[number];

export const PROFILE_COMPLETION_STATUSES = ['incomplete', 'complete', 'invalid'] as const;
export type ProfileCompletionStatus = (typeof PROFILE_COMPLETION_STATUSES)[number];

export const PROFILE_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ProfileChangeStatus = (typeof PROFILE_CHANGE_STATUSES)[number];

export const PROFILE_CHANGE_DECISIONS = ['approved', 'rejected'] as const;
export type ProfileChangeDecision = (typeof PROFILE_CHANGE_DECISIONS)[number];

export const PROTECTED_PROFILE_FIELDS = ['birth_year', 'gender'] as const;
export type ProtectedProfileField = (typeof PROTECTED_PROFILE_FIELDS)[number];

const transitions: Readonly<Record<AccountState, ReadonlySet<AccountState>>> = {
  guest: new Set(['incomplete', 'restricted', 'banned', 'deleted']),
  incomplete: new Set(['active', 'restricted', 'banned', 'deleted']),
  active: new Set(['restricted', 'banned', 'deleted']),
  restricted: new Set(['guest', 'incomplete', 'active', 'banned', 'deleted']),
  banned: new Set(['guest', 'incomplete', 'active', 'restricted', 'deleted']),
  deleted: new Set(['guest']),
};

export function canTransitionAccountState(from: AccountState, to: AccountState): boolean {
  return transitions[from].has(to);
}

export function assertAccountTransition(from: AccountState, to: AccountState): void {
  if (!canTransitionAccountState(from, to)) {
    throw new ApplicationError(
      'invalid_account_transition',
      'error.account.invalid_transition',
      409,
      { from, to },
    );
  }
}

export function nextSignupStep(current: SignupStep): SignupStep {
  const index = SIGNUP_STEPS.indexOf(current);
  return SIGNUP_STEPS[Math.min(index + 1, SIGNUP_STEPS.length - 1)] ?? 'completed';
}
