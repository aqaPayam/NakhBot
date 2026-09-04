import type { Clock } from '../foundation.js';
import { ApplicationError } from '../foundation.js';

export const PROFILE_LIMITS = {
  minimumAge: 18,
  minimumBirthYear: 1900,
  nameCodePoints: 32,
  changeReasonCodePoints: 1024,
  jobCodePoints: 64,
  minimumHeightCm: 100,
  maximumHeightCm: 250,
  minimumInterests: 5,
  maximumInterests: 20,
  maximumLanguages: 10,
  maximumPersonalityTags: 5,
  highlightCodePoints: 80,
  bioCodePoints: 500,
  minimumPhotos: 2,
  maximumPhotos: 6,
} as const;

const digitMap: Readonly<Record<string, string>> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

export type FieldValidationError = Readonly<{
  path: string;
  code: string;
}>;

export function codePointLength(value: string): number {
  return [...value].length;
}

export function normalizeDigits(value: string): string {
  return [...value].map((character) => digitMap[character] ?? character).join('');
}

export function normalizeHumanText(
  value: string,
  input: Readonly<{ path: string; minimum?: number; maximum: number }>,
): string {
  const normalized = value.normalize('NFC').trim();
  if (/\p{Cc}/u.test(normalized)) {
    throw new ApplicationError('invalid_request', 'error.validation.control_character', 400, {
      path: input.path,
    });
  }
  const length = codePointLength(normalized);
  if (length < (input.minimum ?? 0) || length > input.maximum) {
    throw new ApplicationError('invalid_request', 'error.validation.length', 400, {
      path: input.path,
    });
  }
  return normalized;
}

export function parseGregorianBirthYear(value: string, clock: Clock): number {
  const normalized = normalizeDigits(value.trim());
  if (!/^\d{4}$/u.test(normalized)) {
    throw new ApplicationError('invalid_birth_year', 'error.signup.birth_year.invalid', 400, {
      path: 'birthYear',
    });
  }
  const year = Number(normalized);
  const maximum = clock.now().getUTCFullYear() - PROFILE_LIMITS.minimumAge;
  if (year < PROFILE_LIMITS.minimumBirthYear) {
    throw new ApplicationError('invalid_birth_year', 'error.signup.birth_year.invalid', 400, {
      path: 'birthYear',
    });
  }
  if (year > maximum) {
    throw new ApplicationError('underage', 'error.signup.birth_year.underage', 400, {
      path: 'birthYear',
    });
  }
  return year;
}

function distinctCount(values: readonly string[]): number {
  return new Set(values).size;
}

export type ProfileSelectionInput = Readonly<{
  interestCodes: readonly string[];
  languageCodes: readonly string[];
  personalityTagCodes: readonly string[];
}>;

export function validateProfileSelections(input: ProfileSelectionInput): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  if (
    input.interestCodes.length < PROFILE_LIMITS.minimumInterests ||
    input.interestCodes.length > PROFILE_LIMITS.maximumInterests ||
    distinctCount(input.interestCodes) !== input.interestCodes.length
  ) {
    errors.push({ path: 'interestCodes', code: 'error.profile.interests.invalid' });
  }
  if (
    input.languageCodes.length > PROFILE_LIMITS.maximumLanguages ||
    distinctCount(input.languageCodes) !== input.languageCodes.length
  ) {
    errors.push({ path: 'languageCodes', code: 'error.profile.languages.invalid' });
  }
  if (
    input.personalityTagCodes.length > PROFILE_LIMITS.maximumPersonalityTags ||
    distinctCount(input.personalityTagCodes) !== input.personalityTagCodes.length
  ) {
    errors.push({ path: 'personalityTagCodes', code: 'error.profile.personality_tags.invalid' });
  }
  return errors;
}
