import { describe, expect, it } from 'vitest';

import type { ConfirmSignupCommand } from '@nakh/contracts';

import {
  ConfirmSignupHandler,
  type ConfirmationMediaSelection,
  type ProfileMediaEligibilityPort,
  type ProfileStore,
} from './profile.js';

const command: ConfirmSignupCommand = {
  commandId: '20000000-0000-4000-8000-000000000001',
  commandType: 'identity.confirm-signup',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000001' },
  requestId: '30000000-0000-4000-8000-000000000001',
  idempotencyKey: 'confirm-signup-command',
  occurredAt: '2026-09-04T00:00:00.000Z',
  locale: 'en',
  data: { expectedDraftVersion: 13 },
};

describe('ConfirmSignupHandler', () => {
  it('obtains media eligibility before invoking the atomic coordinator', async () => {
    const calls: string[] = [];
    const selection: ConfirmationMediaSelection = {
      primaryMediaAssetId: '40000000-0000-4000-8000-000000000001',
      additionalMediaAssetIds: ['40000000-0000-4000-8000-000000000002'],
    };
    const store = {
      getConfirmationMedia: (userId: string) => {
        calls.push(`selection:${userId}`);
        return Promise.resolve(selection);
      },
      confirmSignup: (write) => {
        calls.push(`confirm:${write.proof.proofId}`);
        return Promise.resolve({
          profile: {
            profileId: write.profileId,
            userId: command.actor.userId,
            name: 'Payam',
            birthYear: 2000,
            genderCode: 'man',
            relationshipGenderPreferenceCode: 'women',
            interestCodes: ['a', 'b', 'c', 'd', 'e'],
            countryCode: 'iran',
            provinceCode: 'tehran',
            cityCode: 'tehran',
            relationshipGoalCode: 'marriage',
            highlight: 'Hello',
            completionStatus: 'complete',
            version: 1,
          },
          accountState: 'active' as const,
          replayed: false,
        });
      },
      updateOwnProfile: () => Promise.reject(new Error('must not execute')),
      getOwnProfile: () => Promise.resolve(undefined),
    } satisfies ProfileStore;
    const media: ProfileMediaEligibilityPort = {
      issueProof: (userId, selected) => {
        calls.push(`media:${userId}:${selected.primaryMediaAssetId}`);
        return Promise.resolve({
          proofId: 'proof-1',
          userId,
          primaryMediaAssetId: selected.primaryMediaAssetId,
          acceptedMediaAssetIds: [
            selected.primaryMediaAssetId,
            ...selected.additionalMediaAssetIds,
          ],
          issuedAt: new Date('2026-09-04T00:00:00.000Z'),
          expiresAt: new Date('2026-09-04T00:10:00.000Z'),
        });
      },
    };
    const ids = ['profile', 'history', 'audit', 'profile-event', 'account-event'];
    const result = await new ConfirmSignupHandler(
      store,
      media,
      { uuid: () => ids.shift() ?? 'unexpected' },
      { now: () => new Date('2026-09-04T00:01:00.000Z') },
    ).execute(command);
    expect(result.accountState).toBe('active');
    expect(calls).toEqual([
      `selection:${command.actor.userId}`,
      `media:${command.actor.userId}:${selection.primaryMediaAssetId}`,
      'confirm:proof-1',
    ]);
  });
});
