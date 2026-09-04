import type { AccountState, ProfileCompletionStatus } from '../identity/account.js';

export const CAPABILITIES = [
  'guest_preview',
  'start_signup',
  'continue_signup',
  'edit_profile',
  'change_settings',
  'start_discovery',
  'view_existing_match',
  'read_existing_chat',
  'send_chat_message',
  'unlock_existing_chat',
  'start_paid_action',
  'start_nakh',
  'settle_pending_nakh',
  'cancel_pending_nakh',
  'act_on_delivered_nakh',
  'create_support',
  'delete_account',
  'create_appeal',
  'return_account',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ENTRY_ROUTES = [
  'guest',
  'continue_signup',
  'main',
  'main_discovery_paused',
  'fix_profile',
  'restricted',
  'ban_appeal',
  'return_decision',
] as const;

export type EntryRoute = (typeof ENTRY_ROUTES)[number];

export type AccessContext = Readonly<{
  accountState: AccountState;
  profileCompletion: ProfileCompletionStatus | null;
  visibilityEnabled: boolean;
  hasExistingMatch?: boolean;
  hasExistingChat?: boolean;
  hasExistingPendingNakh?: boolean;
  hasDeliveredNakh?: boolean;
}>;

export type CapabilityDenialReason =
  | 'account_state_denied'
  | 'profile_incomplete'
  | 'visibility_disabled'
  | 'scope_missing'
  | 'read_only';

export type CapabilityDecision = Readonly<{
  allowed: boolean;
  reasonCode?: CapabilityDenialReason;
  requiredRoute: EntryRoute;
}>;

export function entryRouteFor(context: AccessContext): EntryRoute {
  switch (context.accountState) {
    case 'guest':
      return 'guest';
    case 'incomplete':
      return 'continue_signup';
    case 'active':
      if (context.profileCompletion !== 'complete') return 'fix_profile';
      return context.visibilityEnabled ? 'main' : 'main_discovery_paused';
    case 'restricted':
      return 'restricted';
    case 'banned':
      return 'ban_appeal';
    case 'deleted':
      return 'return_decision';
  }
}

function decision(
  context: AccessContext,
  allowed: boolean,
  reasonCode?: CapabilityDenialReason,
): CapabilityDecision {
  return {
    allowed,
    requiredRoute: entryRouteFor(context),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
}

function requiresScope(context: AccessContext, present: boolean | undefined): CapabilityDecision {
  return decision(context, present === true, present === true ? undefined : 'scope_missing');
}

function evaluateActive(context: AccessContext, capability: Capability): CapabilityDecision {
  const profileComplete = context.profileCompletion === 'complete';
  const discoverable = profileComplete && context.visibilityEnabled;

  if (!profileComplete) {
    switch (capability) {
      case 'edit_profile':
      case 'change_settings':
      case 'create_support':
      case 'delete_account':
        return decision(context, true);
      case 'view_existing_match':
        return requiresScope(context, context.hasExistingMatch);
      case 'read_existing_chat':
      case 'send_chat_message':
      case 'unlock_existing_chat':
        return requiresScope(context, context.hasExistingChat);
      default:
        return decision(context, false, 'profile_incomplete');
    }
  }

  switch (capability) {
    case 'edit_profile':
    case 'change_settings':
    case 'create_support':
    case 'delete_account':
      return decision(context, true);
    case 'start_discovery':
    case 'start_nakh':
      return discoverable
        ? decision(context, true)
        : decision(context, false, 'visibility_disabled');
    case 'start_paid_action':
      return discoverable
        ? decision(context, true)
        : decision(context, false, 'visibility_disabled');
    case 'view_existing_match':
      return requiresScope(context, context.hasExistingMatch);
    case 'read_existing_chat':
    case 'send_chat_message':
    case 'unlock_existing_chat':
      return requiresScope(context, context.hasExistingChat);
    case 'settle_pending_nakh':
    case 'cancel_pending_nakh':
      return requiresScope(context, context.hasExistingPendingNakh);
    case 'act_on_delivered_nakh':
      return requiresScope(context, context.hasDeliveredNakh);
    default:
      return decision(context, false, 'account_state_denied');
  }
}

export function evaluateCapability(
  context: AccessContext,
  capability: Capability,
): CapabilityDecision {
  switch (context.accountState) {
    case 'guest':
      return ['guest_preview', 'start_signup', 'create_support', 'delete_account'].includes(
        capability,
      )
        ? decision(context, true)
        : decision(context, false, 'account_state_denied');
    case 'incomplete':
      return ['guest_preview', 'continue_signup', 'create_support', 'delete_account'].includes(
        capability,
      )
        ? decision(context, true)
        : decision(context, false, 'account_state_denied');
    case 'active':
      return evaluateActive(context, capability);
    case 'restricted':
      if (
        ['edit_profile', 'change_settings', 'create_support', 'delete_account'].includes(capability)
      )
        return decision(context, true);
      if (capability === 'view_existing_match')
        return requiresScope(context, context.hasExistingMatch);
      if (capability === 'read_existing_chat')
        return requiresScope(context, context.hasExistingChat);
      if (capability === 'send_chat_message' && context.hasExistingChat)
        return decision(context, false, 'read_only');
      return decision(context, false, 'account_state_denied');
    case 'banned':
      return capability === 'create_appeal' || capability === 'delete_account'
        ? decision(context, true)
        : decision(context, false, 'account_state_denied');
    case 'deleted':
      return capability === 'return_account'
        ? decision(context, true)
        : decision(context, false, 'account_state_denied');
  }
}
