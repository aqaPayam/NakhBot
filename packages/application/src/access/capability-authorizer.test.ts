import { describe, expect, it } from 'vitest';

import type { Actor } from '@nakh/domain';

import { CapabilityAuthorizer, type CapabilityScopeFactsReader } from './capability-authorizer.js';
import type { IdentityContextSnapshot, IdentityStore } from '../identity/store.js';

const actor: Actor = { kind: 'user', userId: '10000000-0000-4000-8000-000000000001' };

function identity(values: Partial<IdentityContextSnapshot> = {}): IdentityContextSnapshot {
  return {
    userId: actor.userId,
    accountState: 'active',
    profileCompletion: 'complete',
    visibilityEnabled: true,
    uiLocale: 'en',
    guestPreviewCount: 0,
    guestPreviewLimit: 10,
    entryRoute: 'main',
    accountVersion: 1,
    settingsVersion: 1,
    ...values,
  };
}

function store(snapshot: IdentityContextSnapshot): IdentityStore {
  return {
    registerTelegramIdentity: () => Promise.reject(new Error('must not execute')),
    getByTelegramUserId: () => Promise.resolve(undefined),
    getByUserId: () => Promise.resolve(snapshot),
    changeSettings: () => Promise.reject(new Error('must not execute')),
  };
}

describe('CapabilityAuthorizer', () => {
  it('derives identity and scope ownership only from the authenticated actor', async () => {
    const calls: string[] = [];
    const identities = store(identity());
    identities.getByUserId = (userId) => {
      calls.push(`identity:${userId}`);
      return Promise.resolve(identity());
    };
    const reader: CapabilityScopeFactsReader = {
      resolve: (userId, reference) => {
        calls.push(`scope:${userId}:${reference.chatId}`);
        return Promise.resolve({ hasExistingChat: true });
      },
    };

    await expect(
      new CapabilityAuthorizer(identities, reader).authorize(actor, 'read_existing_chat', {
        chatId: '90000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      `identity:${actor.userId}`,
      `scope:${actor.userId}:90000000-0000-4000-8000-000000000001`,
    ]);
  });

  it('ACC-003 blocks discovery for an invalid Profile but preserves existing chat scope', async () => {
    const authorizer = new CapabilityAuthorizer(store(identity({ profileCompletion: 'invalid' })), {
      resolve: () => Promise.resolve({ hasExistingChat: true }),
    });

    await expect(authorizer.canPerform(actor, 'start_discovery')).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'profile_incomplete',
      requiredRoute: 'fix_profile',
    });
    await expect(authorizer.canPerform(actor, 'read_existing_chat')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('ACC-004 pauses new discovery actions but permits an existing pending Nakh settlement', async () => {
    const authorizer = new CapabilityAuthorizer(store(identity({ visibilityEnabled: false })), {
      resolve: () => Promise.resolve({ hasExistingPendingNakh: true }),
    });

    await expect(authorizer.canPerform(actor, 'start_nakh')).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'visibility_disabled',
    });
    await expect(authorizer.canPerform(actor, 'settle_pending_nakh')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('ACC-005 gives restricted accounts read-only access to an existing chat', async () => {
    const authorizer = new CapabilityAuthorizer(store(identity({ accountState: 'restricted' })), {
      resolve: () => Promise.resolve({ hasExistingChat: true }),
    });

    await expect(authorizer.canPerform(actor, 'read_existing_chat')).resolves.toMatchObject({
      allowed: true,
    });
    await expect(authorizer.authorize(actor, 'send_chat_message')).rejects.toMatchObject({
      code: 'capability_denied',
      message: 'error.capability.denied',
      details: { reason: 'read_only' },
    });
  });

  it('ACC-006 limits banned accounts to appeal/deletion policy', async () => {
    const authorizer = new CapabilityAuthorizer(store(identity({ accountState: 'banned' })));

    await expect(authorizer.canPerform(actor, 'create_support')).resolves.toMatchObject({
      allowed: false,
    });
    await expect(authorizer.authorize(actor, 'create_appeal')).resolves.toBeUndefined();
  });
});
