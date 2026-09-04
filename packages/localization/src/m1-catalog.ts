export type LocalizationCategory =
  'button' | 'message' | 'error' | 'admin' | 'payment' | 'notification' | 'safety';

export type LocalizationManifestEntry = Readonly<{
  key: string;
  category: LocalizationCategory;
  english: string;
  variables: readonly string[];
  required: boolean;
}>;

const CORE_M1_ENGLISH_ENTRIES = [
  { key: 'start.guest.title', category: 'message', english: 'Welcome to Nakh' },
  {
    key: 'start.incomplete.title',
    category: 'message',
    english: 'Continue your profile',
  },
  {
    key: 'start.main.title',
    category: 'message',
    english: 'What would you like to do?',
  },
  {
    key: 'start.discovery_paused.title',
    category: 'message',
    english: 'Discovery is paused while your visibility is off.',
  },
  {
    key: 'start.fix_profile.title',
    category: 'message',
    english: 'Fix your profile to continue discovering people.',
  },
  {
    key: 'start.restricted.title',
    category: 'safety',
    english: 'Your account currently has limited access.',
  },
  {
    key: 'start.banned.title',
    category: 'safety',
    english: 'Your account is banned. You may review your appeal options.',
  },
  {
    key: 'start.deleted.title',
    category: 'message',
    english: 'This account was deleted. Return availability must be reviewed.',
  },
  {
    key: 'common.button.guest_preview',
    category: 'button',
    english: 'Browse as guest',
  },
  { key: 'common.button.sign_up', category: 'button', english: 'Sign up' },
  {
    key: 'common.button.continue_signup',
    category: 'button',
    english: 'Continue signup',
  },
  { key: 'common.button.settings', category: 'button', english: 'Settings' },
  { key: 'common.button.support', category: 'button', english: 'Support' },
  { key: 'common.button.edit_profile', category: 'button', english: 'Edit profile' },
  { key: 'common.button.appeal', category: 'button', english: 'Appeal' },
  { key: 'common.button.delete_account', category: 'button', english: 'Delete account' },
  {
    key: 'common.button.return_status',
    category: 'button',
    english: 'Check return status',
  },
  {
    key: 'error.account.invalid_transition',
    category: 'error',
    english: 'That account change is not allowed.',
  },
  {
    key: 'error.signup.birth_year.invalid',
    category: 'error',
    english: 'Enter a four-digit Gregorian birth year.',
  },
  {
    key: 'error.signup.birth_year.underage',
    category: 'error',
    english: 'You must be at least 18 to use Nakh.',
  },
  {
    key: 'error.validation.control_character',
    category: 'error',
    english: 'Remove unsupported control characters.',
  },
  {
    key: 'error.validation.length',
    category: 'error',
    english: 'This value has an invalid length.',
  },
  {
    key: 'error.identity.telegram_context_invalid',
    category: 'error',
    english: 'This Telegram request could not be authenticated.',
  },
  {
    key: 'error.command.idempotency_conflict',
    category: 'error',
    english: 'This request identifier was already used for different data.',
  },
  {
    key: 'error.command.in_progress',
    category: 'error',
    english: 'This request is already being processed.',
  },
  {
    key: 'error.identity.user_context_invalid',
    category: 'error',
    english: 'This user request could not be authenticated.',
  },
  {
    key: 'error.capability.denied',
    category: 'error',
    english: 'This action is not available for your account.',
  },
  {
    key: 'error.settings.version_conflict',
    category: 'error',
    english: 'Your settings changed elsewhere. Refresh and try again.',
  },
  {
    key: 'error.settings.locale_inactive',
    category: 'error',
    english: 'That language is not currently available.',
  },
  {
    key: 'signup.age_confirmation.prompt',
    category: 'message',
    english: 'Confirm that you are at least 18 years old.',
  },
  {
    key: 'signup.name.prompt',
    category: 'message',
    english: 'What name should appear on your profile?',
  },
  {
    key: 'signup.birth_year.prompt',
    category: 'message',
    english: 'What is your Gregorian birth year?',
  },
  { key: 'signup.gender.prompt', category: 'message', english: 'Select your gender.' },
  {
    key: 'signup.relationship_gender_preference.prompt',
    category: 'message',
    english: 'Who would you like to meet?',
  },
  {
    key: 'signup.interests.prompt',
    category: 'message',
    english: 'Choose between 5 and 20 interests.',
  },
  {
    key: 'signup.location.prompt',
    category: 'message',
    english: 'Select your country, province, and city.',
  },
  {
    key: 'signup.relationship_goal.prompt',
    category: 'message',
    english: 'What kind of relationship are you looking for?',
  },
  {
    key: 'signup.primary_photo.prompt',
    category: 'message',
    english: 'Choose your primary photo.',
  },
  {
    key: 'signup.additional_photos.prompt',
    category: 'message',
    english: 'Add at least one more photo.',
  },
  {
    key: 'signup.highlight.prompt',
    category: 'message',
    english: 'Write a short profile highlight.',
  },
  {
    key: 'signup.optional_details.prompt',
    category: 'message',
    english: 'Add optional details or continue.',
  },
  {
    key: 'signup.confirm_profile.prompt',
    category: 'message',
    english: 'Review and confirm your profile.',
  },
  { key: 'signup.completed.prompt', category: 'message', english: 'Your profile is complete.' },
  {
    key: 'error.signup.step.invalid',
    category: 'error',
    english: 'This signup step cannot be saved now.',
  },
  {
    key: 'error.signup.version_conflict',
    category: 'error',
    english: 'Your signup changed elsewhere. Resume from the current step.',
  },
  {
    key: 'error.signup.catalog_inactive',
    category: 'error',
    english: 'One of the selected options is no longer available.',
  },
  {
    key: 'error.signup.location_invalid',
    category: 'error',
    english: 'Select a valid active country, province, and city.',
  },
  {
    key: 'error.signup.draft_invalid',
    category: 'error',
    english: 'Your saved signup data cannot be read safely.',
  },
  {
    key: 'error.profile.interests.invalid',
    category: 'error',
    english: 'Choose between 5 and 20 distinct interests.',
  },
  {
    key: 'error.profile.languages.invalid',
    category: 'error',
    english: 'Choose at most 10 distinct languages.',
  },
  {
    key: 'error.profile.personality_tags.invalid',
    category: 'error',
    english: 'Choose at most 5 distinct personality tags.',
  },
  {
    key: 'error.signup.optional_details.invalid',
    category: 'error',
    english: 'One of the optional profile details is invalid.',
  },
] as const satisfies ReadonlyArray<Omit<LocalizationManifestEntry, 'variables' | 'required'>>;

const CATALOG_GROUPS = [
  { namespace: 'gender', codes: ['man', 'woman', 'other'] },
  { namespace: 'gender_preference', codes: ['men', 'women', 'everyone'] },
  {
    namespace: 'relationship_goal',
    codes: ['serious_relationship', 'casual_dating', 'friendship', 'marriage', 'not_sure_yet'],
  },
  {
    namespace: 'interest',
    codes: [
      'travel',
      'music',
      'movies',
      'books',
      'fitness',
      'hiking',
      'cooking',
      'coffee',
      'photography',
      'art',
      'gaming',
      'technology',
      'animals',
      'nature',
      'dancing',
      'fashion',
      'football',
      'volleyball',
      'basketball',
      'running',
      'cycling',
      'swimming',
      'yoga',
      'languages',
      'history',
      'science',
      'entrepreneurship',
      'volunteering',
      'food',
      'cars',
    ],
  },
  {
    namespace: 'language',
    codes: [
      'persian',
      'english',
      'azerbaijani_turkish',
      'kurdish',
      'luri',
      'gilaki',
      'mazandarani',
      'arabic',
      'armenian',
      'turkmen',
      'balochi',
      'turkish',
      'french',
      'german',
    ],
  },
  {
    namespace: 'personality_tag',
    codes: [
      'adventurous',
      'ambitious',
      'calm',
      'creative',
      'curious',
      'family_oriented',
      'funny',
      'kind',
      'outgoing',
      'romantic',
      'thoughtful',
      'independent',
    ],
  },
  {
    namespace: 'education_level',
    codes: [
      'high_school_or_less',
      'vocational',
      'associate',
      'bachelor',
      'master',
      'doctorate',
      'other',
    ],
  },
  {
    namespace: 'smoking_preference',
    codes: ['never', 'occasionally', 'regularly', 'trying_to_quit'],
  },
  {
    namespace: 'pets_preference',
    codes: ['have_pets', 'want_pets', 'like_pets', 'no_pets', 'allergic'],
  },
  {
    namespace: 'exercise_frequency',
    codes: ['never', 'occasionally', 'weekly', 'frequently', 'daily'],
  },
  {
    namespace: 'religion_importance',
    codes: ['not_important', 'somewhat_important', 'very_important'],
  },
  {
    namespace: 'children_preference',
    codes: [
      'want_children',
      'do_not_want_children',
      'have_and_want_more',
      'have_and_do_not_want_more',
      'not_sure',
    ],
  },
  { namespace: 'country', codes: ['iran'] },
  { namespace: 'province', codes: ['tehran', 'isfahan'] },
  { namespace: 'city', codes: ['tehran', 'isfahan'] },
] as const;

function englishCatalogLabel(code: string): string {
  return code
    .split('_')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export const M1_CATALOG_LOCALIZATION_ENTRIES: readonly LocalizationManifestEntry[] =
  CATALOG_GROUPS.flatMap((group) =>
    group.codes.map((code) => ({
      key: `catalog.${group.namespace}.${code}`,
      category: 'message' as const,
      english: englishCatalogLabel(code),
      variables: [],
      required: true,
    })),
  );

export const M1_LOCALIZATION_MANIFEST: readonly LocalizationManifestEntry[] = [
  ...CORE_M1_ENGLISH_ENTRIES.map((entry) => ({ ...entry, variables: [], required: true })),
  ...M1_CATALOG_LOCALIZATION_ENTRIES,
];

export function englishCatalogFromManifest(): Readonly<Record<string, string>> {
  return Object.fromEntries(M1_LOCALIZATION_MANIFEST.map((entry) => [entry.key, entry.english]));
}

export function validateLocalizationManifest(): readonly string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const entry of M1_LOCALIZATION_MANIFEST) {
    if (keys.has(entry.key)) errors.push(`duplicate:${entry.key}`);
    keys.add(entry.key);
    const declared = new Set(entry.variables);
    const used = new Set(
      [...entry.english.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    );
    if ([...declared].some((variable) => !used.has(variable)))
      errors.push(`unused-variable:${entry.key}`);
    if ([...used].some((variable) => !declared.has(variable)))
      errors.push(`undeclared-variable:${entry.key}`);
  }
  return errors;
}
