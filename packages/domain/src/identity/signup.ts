import type { Clock } from '../foundation.js';
import { ApplicationError } from '../foundation.js';
import {
  PROFILE_LIMITS,
  normalizeHumanText,
  parseGregorianBirthYear,
  validateProfileSelections,
} from '../profile/validation.js';

export type SignupCatalogSnapshot = Readonly<{
  genderCodes: readonly string[];
  genderPreferenceCodes: readonly string[];
  relationshipGoalCodes: readonly string[];
  interestCodes: readonly string[];
  languageCodes: readonly string[];
  personalityTagCodes: readonly string[];
  optionCodes: Readonly<Record<string, readonly string[]>>;
  locations: ReadonlyArray<
    Readonly<{ countryCode: string; provinceCode: string; cityCode: string }>
  >;
}>;

export type SignupStepInput =
  | Readonly<{ step: 'age_confirmation'; accepted: true }>
  | Readonly<{ step: 'name'; value: string }>
  | Readonly<{ step: 'birth_year'; value: string }>
  | Readonly<{ step: 'gender'; code: string }>
  | Readonly<{ step: 'relationship_gender_preference'; code: string }>
  | Readonly<{ step: 'interests'; codes: readonly string[] }>
  | Readonly<{
      step: 'location';
      countryCode: string;
      provinceCode: string;
      cityCode: string;
    }>
  | Readonly<{ step: 'relationship_goal'; code: string }>
  | Readonly<{ step: 'primary_photo'; mediaAssetId: string }>
  | Readonly<{ step: 'additional_photos'; mediaAssetIds: readonly string[] }>
  | Readonly<{ step: 'highlight'; value: string }>
  | Readonly<{
      step: 'optional_details';
      value: Readonly<{
        heightCm?: number;
        job?: string;
        educationLevelCode?: string;
        smokingPreferenceCode?: string;
        petsPreferenceCode?: string;
        exerciseFrequencyCode?: string;
        religionCode?: string;
        childrenPreferenceCode?: string;
        languageCodes?: readonly string[];
        personalityTagCodes?: readonly string[];
        bio?: string;
      }>;
    }>
  | Readonly<{ step: 'confirm_profile'; confirmed: true }>;

export type NormalizedSignupStep =
  SignupStepInput | Readonly<{ step: 'birth_year'; value: number }>;

function requireActive(code: string, values: readonly string[], path: string): void {
  if (!values.includes(code)) {
    throw new ApplicationError('inactive_catalog_selection', 'error.signup.catalog_inactive', 400, {
      path,
    });
  }
}

function requireActiveMany(
  codes: readonly string[],
  values: readonly string[],
  path: string,
): void {
  if (codes.some((code) => !values.includes(code))) {
    throw new ApplicationError('inactive_catalog_selection', 'error.signup.catalog_inactive', 400, {
      path,
    });
  }
}

export function normalizeSignupStep(
  input: SignupStepInput,
  catalogs: SignupCatalogSnapshot,
  clock: Clock,
): NormalizedSignupStep {
  switch (input.step) {
    case 'age_confirmation':
      return input;
    case 'name':
      return {
        step: input.step,
        value: normalizeHumanText(input.value, {
          path: 'name',
          minimum: 1,
          maximum: PROFILE_LIMITS.nameCodePoints,
        }),
      };
    case 'birth_year':
      return { step: input.step, value: parseGregorianBirthYear(input.value, clock) };
    case 'gender':
      requireActive(input.code, catalogs.genderCodes, 'gender');
      return input;
    case 'relationship_gender_preference':
      requireActive(input.code, catalogs.genderPreferenceCodes, 'relationshipGenderPreference');
      return input;
    case 'interests': {
      const errors = validateProfileSelections({
        interestCodes: input.codes,
        languageCodes: [],
        personalityTagCodes: [],
      });
      const error = errors.find((item) => item.path === 'interestCodes');
      if (error !== undefined)
        throw new ApplicationError('invalid_signup_step', error.code, 400, { path: error.path });
      requireActiveMany(input.codes, catalogs.interestCodes, 'interestCodes');
      return input;
    }
    case 'location':
      if (
        !catalogs.locations.some(
          (location) =>
            location.countryCode === input.countryCode &&
            location.provinceCode === input.provinceCode &&
            location.cityCode === input.cityCode,
        )
      ) {
        throw new ApplicationError('invalid_location', 'error.signup.location_invalid', 400, {
          path: 'location',
        });
      }
      return input;
    case 'relationship_goal':
      requireActive(input.code, catalogs.relationshipGoalCodes, 'relationshipGoal');
      return input;
    case 'primary_photo':
    case 'additional_photos':
      return input;
    case 'highlight':
      return {
        step: input.step,
        value: normalizeHumanText(input.value, {
          path: 'highlight',
          minimum: 1,
          maximum: PROFILE_LIMITS.highlightCodePoints,
        }),
      };
    case 'optional_details': {
      const value = input.value;
      if (
        value.heightCm !== undefined &&
        (value.heightCm < PROFILE_LIMITS.minimumHeightCm ||
          value.heightCm > PROFILE_LIMITS.maximumHeightCm)
      ) {
        throw new ApplicationError(
          'invalid_signup_step',
          'error.signup.optional_details.invalid',
          400,
          { path: 'heightCm' },
        );
      }
      const languageCodes = value.languageCodes ?? [];
      const personalityTagCodes = value.personalityTagCodes ?? [];
      if (
        languageCodes.length > PROFILE_LIMITS.maximumLanguages ||
        new Set(languageCodes).size !== languageCodes.length
      ) {
        throw new ApplicationError('invalid_signup_step', 'error.profile.languages.invalid', 400, {
          path: 'languageCodes',
        });
      }
      if (
        personalityTagCodes.length > PROFILE_LIMITS.maximumPersonalityTags ||
        new Set(personalityTagCodes).size !== personalityTagCodes.length
      ) {
        throw new ApplicationError(
          'invalid_signup_step',
          'error.profile.personality_tags.invalid',
          400,
          { path: 'personalityTagCodes' },
        );
      }
      requireActiveMany(languageCodes, catalogs.languageCodes, 'languageCodes');
      requireActiveMany(personalityTagCodes, catalogs.personalityTagCodes, 'personalityTagCodes');
      const optionalCatalogs = [
        ['educationLevelCode', 'education_level', value.educationLevelCode],
        ['smokingPreferenceCode', 'smoking_preference', value.smokingPreferenceCode],
        ['petsPreferenceCode', 'pets_preference', value.petsPreferenceCode],
        ['exerciseFrequencyCode', 'exercise_frequency', value.exerciseFrequencyCode],
        ['religionCode', 'religion_importance', value.religionCode],
        ['childrenPreferenceCode', 'children_preference', value.childrenPreferenceCode],
      ] as const;
      for (const [path, category, code] of optionalCatalogs) {
        if (code !== undefined) requireActive(code, catalogs.optionCodes[category] ?? [], path);
      }
      return {
        step: input.step,
        value: {
          ...value,
          ...(value.job === undefined
            ? {}
            : {
                job: normalizeHumanText(value.job, {
                  path: 'job',
                  maximum: PROFILE_LIMITS.jobCodePoints,
                }),
              }),
          ...(value.bio === undefined
            ? {}
            : {
                bio: normalizeHumanText(value.bio, {
                  path: 'bio',
                  maximum: PROFILE_LIMITS.bioCodePoints,
                }),
              }),
        },
      };
    }
    case 'confirm_profile':
      throw new ApplicationError('invalid_signup_step', 'error.signup.step.invalid', 409, {
        path: 'confirm_profile',
      });
  }
}
