import type { Clock } from '../foundation.js';
import { ApplicationError } from '../foundation.js';

import { normalizeHumanText, parseGregorianBirthYear, PROFILE_LIMITS } from './validation.js';

export type ProtectedProfileChangeInput =
  | Readonly<{ field: 'birth_year'; requestedValue: number; reason: string }>
  | Readonly<{ field: 'gender'; requestedValue: string; reason: string }>;

export type NormalizedProtectedProfileChange = ProtectedProfileChangeInput;

export function normalizeProtectedProfileChange(
  input: ProtectedProfileChangeInput,
  clock: Clock,
): NormalizedProtectedProfileChange {
  const reason = normalizeHumanText(input.reason, {
    path: 'reason',
    minimum: 1,
    maximum: PROFILE_LIMITS.changeReasonCodePoints,
  });
  if (input.field === 'birth_year') {
    if (!Number.isInteger(input.requestedValue))
      throw new ApplicationError('invalid_birth_year', 'error.signup.birth_year.invalid', 400);
    return {
      field: input.field,
      requestedValue: parseGregorianBirthYear(String(input.requestedValue), clock),
      reason,
    };
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(input.requestedValue))
    throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 400);
  return { field: input.field, requestedValue: input.requestedValue, reason };
}

export function normalizeProfileChangeReviewNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  return normalizeHumanText(note, { path: 'note', maximum: 4096 });
}
