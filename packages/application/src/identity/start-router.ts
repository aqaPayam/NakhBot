import type { EntryRoute } from '@nakh/domain';

import type { LocalizedIntent } from '../presentation.js';

export type StartAction = Readonly<{
  intent: string;
  label: LocalizedIntent;
}>;

export type StartViewModel = Readonly<{
  route: EntryRoute;
  title: LocalizedIntent;
  actions: readonly StartAction[];
}>;

const localized = (key: string): LocalizedIntent => ({ key, variables: {} });
const action = (name: string, labelKey: string): StartAction => ({
  intent: name,
  label: localized(labelKey),
});

const common = {
  settings: action('settings.open', 'common.button.settings'),
  support: action('support.open', 'common.button.support'),
} as const;

export function routeStart(entryRoute: EntryRoute): StartViewModel {
  switch (entryRoute) {
    case 'guest':
      return {
        route: entryRoute,
        title: localized('start.guest.title'),
        actions: [
          action('guest-preview.next', 'common.button.guest_preview'),
          action('signup.start', 'common.button.sign_up'),
          common.support,
        ],
      };
    case 'continue_signup':
      return {
        route: entryRoute,
        title: localized('start.incomplete.title'),
        actions: [
          action('signup.continue', 'common.button.continue_signup'),
          action('guest-preview.next', 'common.button.guest_preview'),
          common.support,
        ],
      };
    case 'main':
      return {
        route: entryRoute,
        title: localized('start.main.title'),
        actions: [common.settings, common.support],
      };
    case 'main_discovery_paused':
      return {
        route: entryRoute,
        title: localized('start.discovery_paused.title'),
        actions: [common.settings, common.support],
      };
    case 'fix_profile':
      return {
        route: entryRoute,
        title: localized('start.fix_profile.title'),
        actions: [
          action('profile.edit', 'common.button.edit_profile'),
          common.settings,
          common.support,
        ],
      };
    case 'restricted':
      return {
        route: entryRoute,
        title: localized('start.restricted.title'),
        actions: [
          action('profile.edit', 'common.button.edit_profile'),
          common.settings,
          common.support,
        ],
      };
    case 'ban_appeal':
      return {
        route: entryRoute,
        title: localized('start.banned.title'),
        actions: [
          action('appeal.open', 'common.button.appeal'),
          action('account.delete', 'common.button.delete_account'),
        ],
      };
    case 'return_decision':
      return {
        route: entryRoute,
        title: localized('start.deleted.title'),
        actions: [action('account.return-status', 'common.button.return_status')],
      };
  }
}
