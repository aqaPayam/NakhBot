import { describe, expect, it } from 'vitest';

import {
  assertExploreFilter,
  candidateMatchesFilter,
  canTransitionLikeStatus,
  canTransitionPairState,
  normalizeUserPair,
  shuffleCandidates,
  type DiscoveryProfileFacts,
} from './discovery.js';

const viewer: DiscoveryProfileFacts = {
  userId: '10000000-0000-4000-8000-000000000001',
  genderOptionId: 'man',
  acceptedGenderOptionIds: ['woman'],
  birthYear: 1995,
  cityId: 'tehran',
  relationshipGoalCode: 'serious_relationship',
};
const target: DiscoveryProfileFacts = {
  userId: '20000000-0000-4000-8000-000000000002',
  genderOptionId: 'woman',
  acceptedGenderOptionIds: ['man'],
  birthYear: 1997,
  cityId: 'tehran',
  relationshipGoalCode: 'serious_relationship',
};
const filter = {
  targetGenderOptionIds: ['woman'],
  minAge: 20,
  maxAge: 40,
  cityId: 'tehran',
} as const;

describe('M3 discovery policy', () => {
  it('normalizes pairs identically in both directions and rejects self pairs', () => {
    expect(normalizeUserPair(viewer.userId, target.userId)).toEqual(
      normalizeUserPair(target.userId.toUpperCase(), viewer.userId),
    );
    expect(() => normalizeUserPair(viewer.userId, viewer.userId)).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
        message: 'error.interaction.pair_invalid',
      }),
    );
  });

  it('proves ACC-015 filters can only narrow reciprocal compatibility', () => {
    expect(candidateMatchesFilter(viewer, target, filter, 2026)).toBe(true);
    expect(
      candidateMatchesFilter(
        viewer,
        { ...target, acceptedGenderOptionIds: ['woman'] },
        filter,
        2026,
      ),
    ).toBe(false);
    expect(() =>
      assertExploreFilter({ ...filter, targetGenderOptionIds: ['man', 'woman'] }, ['woman']),
    ).toThrowError(expect.objectContaining({ message: 'error.discovery.gender_filter_invalid' }));
  });

  it.each([
    [{ ...target, cityId: 'isfahan' }, false],
    [{ ...target, birthYear: 1980 }, false],
    [{ ...target, relationshipGoalCode: 'friendship' }, true],
  ] as const)('applies independent filters to candidate facts', (candidate, expected) => {
    expect(candidateMatchesFilter(viewer, candidate, filter, 2026)).toBe(expected);
  });

  it('locks irreversible Like and pair transitions', () => {
    expect(canTransitionLikeStatus('active', 'closed_by_match')).toBe(true);
    expect(canTransitionLikeStatus('closed_by_not_interested', 'active')).toBe(false);
    expect(canTransitionLikeStatus('closed_by_match', 'closed_by_unmatch')).toBe(true);
    expect(canTransitionPairState(undefined, 'matched')).toBe(true);
    expect(canTransitionPairState('matched', 'unmatched')).toBe(true);
    expect(canTransitionPairState('unmatched', 'matched')).toBe(false);
    expect(canTransitionPairState('blocked', undefined, true)).toBe(true);
  });

  it('shuffles only bounded pools deterministically without mutating input', () => {
    const input = [1, 2, 3, 4, 5];
    expect(shuffleCandidates(input, 42)).toEqual(shuffleCandidates(input, 42));
    expect([...shuffleCandidates(input, 42)].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect(() => shuffleCandidates(Array.from({ length: 101 }), 1)).toThrowError(
      expect.objectContaining({ message: 'error.discovery.candidate_pool_invalid' }),
    );
  });
});
