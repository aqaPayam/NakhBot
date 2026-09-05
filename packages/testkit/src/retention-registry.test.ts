import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('M1 deletion and retention registry', () => {
  it('classifies every M1 User-linked persistence family', async () => {
    const registry = await readFile(
      resolve(process.cwd(), 'docs/technical/17-data-retention-registry.md'),
      'utf8',
    );
    for (const resource of [
      'identity.users',
      'identity.telegram_identities',
      'identity.accounts',
      'identity.account_state_history',
      'identity.guest_preview_counters',
      'identity.user_settings',
      'identity.signup_progress',
      'identity.signup_drafts',
      'billing.credit_accounts',
      'notification.notification_preferences',
      'profile.profiles',
      'profile.profile_change_requests',
      'profile.profile_change_reviews',
      'administration.admin_users',
    ])
      expect(registry, resource).toContain(`\`${resource}\``);
  });
});
