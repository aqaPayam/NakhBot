export type LocalizationCategory =
  'button' | 'message' | 'error' | 'admin' | 'payment' | 'notification' | 'safety';

export type LocalizationManifestEntry = Readonly<{
  key: string;
  category: LocalizationCategory;
  english: string;
  variables: readonly string[];
  required: boolean;
}>;

const M1_ENGLISH_ENTRIES = [
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
] as const satisfies ReadonlyArray<Omit<LocalizationManifestEntry, 'variables' | 'required'>>;

export const M1_LOCALIZATION_MANIFEST: readonly LocalizationManifestEntry[] =
  M1_ENGLISH_ENTRIES.map((entry) => ({ ...entry, variables: [], required: true }));

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
