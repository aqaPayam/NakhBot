import type { Actor } from '@nakh/domain';
import {
  ApplicationError,
  evaluateCapability,
  type AccessContext,
  type Capability,
  type CapabilityDecision,
} from '@nakh/domain';

import type { IdentityStore } from '../identity/store.js';

export type CapabilityScopeReference = Readonly<{
  matchId?: string;
  chatId?: string;
  nakhId?: string;
}>;

export type CapabilityScopeFacts = Pick<
  AccessContext,
  'hasExistingMatch' | 'hasExistingChat' | 'hasExistingPendingNakh' | 'hasDeliveredNakh'
>;

export interface CapabilityScopeFactsReader {
  resolve(userId: string, reference: CapabilityScopeReference): Promise<CapabilityScopeFacts>;
}

const noScopeFacts: CapabilityScopeFactsReader = {
  resolve: () => Promise.resolve({}),
};

export class CapabilityAuthorizer {
  public constructor(
    private readonly identities: IdentityStore,
    private readonly scopeFacts: CapabilityScopeFactsReader = noScopeFacts,
  ) {}

  public async canPerform(
    actor: Actor,
    capability: Capability,
    reference: CapabilityScopeReference = {},
  ): Promise<CapabilityDecision> {
    if (actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const identity = await this.identities.getByUserId(actor.userId);
    if (identity === undefined)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const facts = await this.scopeFacts.resolve(actor.userId, reference);
    return evaluateCapability(
      {
        accountState: identity.accountState,
        profileCompletion: identity.profileCompletion,
        visibilityEnabled: identity.visibilityEnabled,
        ...facts,
      },
      capability,
    );
  }

  public async authorize(
    actor: Actor,
    capability: Capability,
    reference: CapabilityScopeReference = {},
  ): Promise<void> {
    const decision = await this.canPerform(actor, capability, reference);
    if (!decision.allowed) {
      throw new ApplicationError('capability_denied', 'error.capability.denied', 403, {
        reason: decision.reasonCode ?? 'account_state_denied',
        requiredRoute: decision.requiredRoute,
      });
    }
  }
}
