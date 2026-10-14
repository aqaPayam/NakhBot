import type { LocalizationManifestEntry } from './m1-catalog.js';
/** Limited deletion controls contain no user or retained-content interpolation. */
export const M8_LOCALIZATION_ENTRIES: readonly LocalizationManifestEntry[] = [
  {
    key: 'deletion.button.confirm',
    category: 'button',
    english: 'Delete my account',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.button.cancel',
    category: 'button',
    english: 'Cancel',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.confirm',
    category: 'message',
    english:
      'Delete your account and product data? This cannot be undone. Some financial and safety records may be retained under their applicable policy.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.progress',
    category: 'message',
    english:
      'Your account is deleted. Cleanup is in progress. Use /delete_status to check progress.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.completed',
    category: 'message',
    english: 'Your account deletion is complete.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.completed_denied',
    category: 'message',
    english: 'Your account deletion is complete. Returning is unavailable for this account.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.not_requested',
    category: 'message',
    english: 'No account deletion has been requested.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.cancelled',
    category: 'message',
    english: 'That deletion confirmation was cancelled.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.unavailable',
    category: 'error',
    english: 'This action is unavailable. Use /delete_status to check your account.',
    variables: [],
    required: true,
  },
  {
    key: 'deletion.rate_limited',
    category: 'error',
    english: 'Please wait before trying this account action again.',
    variables: [],
    required: true,
  },
];
