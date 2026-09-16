import { ApplicationError } from '../foundation.js';

export const EXPLORE_CONSUMPTION_REASONS = [
  'preview',
  'like',
  'not_interested',
  'nakh_flow',
  'match',
] as const;
export type ExploreConsumptionReason = (typeof EXPLORE_CONSUMPTION_REASONS)[number];

export const LIKE_STATUSES = [
  'active',
  'closed_by_match',
  'closed_by_not_interested',
  'closed_by_unmatch',
  'cancelled_by_system',
] as const;
export type LikeStatus = (typeof LIKE_STATUSES)[number];

export const PAIR_STATES = ['matched', 'unmatched', 'blocked'] as const;
export type UserPairState = (typeof PAIR_STATES)[number];
export type NotInterestedSource = 'explore' | 'liked_by' | 'cancelled_pending_nakh';

export type ExploreFilter = Readonly<{
  targetGenderOptionIds: readonly string[];
  minAge: number;
  maxAge: number;
  cityId: string;
  relationshipGoalCode?: string;
}>;

export type DiscoveryProfileFacts = Readonly<{
  userId: string;
  genderOptionId: string;
  acceptedGenderOptionIds: readonly string[];
  birthYear: number;
  cityId: string;
  relationshipGoalCode: string;
}>;

export type NormalizedUserPair = Readonly<{ userLowId: string; userHighId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function normalizeUserPair(leftUserId: string, rightUserId: string): NormalizedUserPair {
  const left = leftUserId.toLowerCase();
  const right = rightUserId.toLowerCase();
  if (!UUID.test(left) || !UUID.test(right) || left === right)
    throw new ApplicationError('invalid_request', 'error.interaction.pair_invalid', 400);
  return left < right
    ? { userLowId: left, userHighId: right }
    : { userLowId: right, userHighId: left };
}

export function assertExploreFilter(
  filter: ExploreFilter,
  viewerPreferenceGenderIds: readonly string[],
): void {
  const genders = new Set(filter.targetGenderOptionIds);
  const preference = new Set(viewerPreferenceGenderIds);
  if (
    filter.targetGenderOptionIds.length < 1 ||
    genders.size !== filter.targetGenderOptionIds.length ||
    [...genders].some((gender) => !preference.has(gender))
  )
    throw new ApplicationError('invalid_request', 'error.discovery.gender_filter_invalid', 400);
  if (
    !Number.isInteger(filter.minAge) ||
    !Number.isInteger(filter.maxAge) ||
    filter.minAge < 18 ||
    filter.maxAge > 120 ||
    filter.minAge > filter.maxAge
  )
    throw new ApplicationError('invalid_request', 'error.discovery.age_filter_invalid', 400);
  if (filter.cityId.length === 0)
    throw new ApplicationError('invalid_request', 'error.discovery.city_filter_invalid', 400);
}

export function approximateAge(birthYear: number, currentGregorianYear: number): number {
  if (
    !Number.isInteger(birthYear) ||
    !Number.isInteger(currentGregorianYear) ||
    birthYear < 1900 ||
    currentGregorianYear < birthYear
  )
    throw new ApplicationError('invalid_request', 'error.discovery.age_invalid', 400);
  return currentGregorianYear - birthYear;
}

export function isReciprocallyCompatible(
  viewer: DiscoveryProfileFacts,
  target: DiscoveryProfileFacts,
): boolean {
  return (
    viewer.acceptedGenderOptionIds.includes(target.genderOptionId) &&
    target.acceptedGenderOptionIds.includes(viewer.genderOptionId)
  );
}

export function candidateMatchesFilter(
  viewer: DiscoveryProfileFacts,
  target: DiscoveryProfileFacts,
  filter: ExploreFilter,
  currentGregorianYear: number,
): boolean {
  assertExploreFilter(filter, viewer.acceptedGenderOptionIds);
  const age = approximateAge(target.birthYear, currentGregorianYear);
  return (
    viewer.userId !== target.userId &&
    isReciprocallyCompatible(viewer, target) &&
    filter.targetGenderOptionIds.includes(target.genderOptionId) &&
    target.cityId === filter.cityId &&
    age >= filter.minAge &&
    age <= filter.maxAge &&
    (filter.relationshipGoalCode === undefined ||
      target.relationshipGoalCode === filter.relationshipGoalCode)
  );
}

export function canTransitionLikeStatus(current: LikeStatus, next: LikeStatus): boolean {
  if (current === 'active') return next !== 'active';
  return current === 'closed_by_match' && next === 'closed_by_unmatch';
}

export function canTransitionPairState(
  current: UserPairState | undefined,
  next: UserPairState | undefined,
  adminSafetyReversal = false,
): boolean {
  if (next === 'blocked') return current !== 'blocked';
  if (current === undefined) return next === 'matched';
  if (current === 'matched') return next === 'unmatched';
  return current === 'blocked' && next === undefined && adminSafetyReversal;
}

/** Bounded deterministic Fisher-Yates shuffle. The caller must cap candidates before calling. */
export function shuffleCandidates<T>(values: readonly T[], seed: number): readonly T[] {
  if (values.length > 100 || !Number.isSafeInteger(seed))
    throw new ApplicationError('invalid_request', 'error.discovery.candidate_pool_invalid', 400);
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const selected = (state >>> 0) % (index + 1);
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}
