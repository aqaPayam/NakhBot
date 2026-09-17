import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GetNextExploreCandidateQuery } from '@nakh/contracts';

import { PostgresCandidateReservationStore } from './candidate-reservation-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { seedValidMedia } from './media-fixtures.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const manGenderId = '20000000-0000-4000-8000-000000000001';
const womanGenderId = '20000000-0000-4000-8000-000000000002';
const menPreferenceId = '20000000-0000-4000-8000-000000000011';
const womenPreferenceId = '20000000-0000-4000-8000-000000000012';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const defaultCityId = '20000000-0000-4000-8000-000000000121';

async function createUser(
  database: NakhDatabase,
  accountState: 'guest' | 'active',
  profile?: Readonly<{
    genderOptionId: string;
    genderPreferenceId: string;
    birthYear: number;
    primaryPhoto: boolean;
    cityId?: string;
  }>,
  previewCount = 0,
): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({
      user_id: userId,
      state: accountState,
      state_reason: null,
      state_changed_at: now,
    })
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.guest_preview_counters')
    .values({
      user_id: userId,
      preview_count: previewCount,
      limit_count: 10,
      first_preview_at: previewCount === 0 ? null : now,
      last_preview_at: previewCount === 0 ? null : now,
    })
    .execute();
  if (profile !== undefined) {
    const profileId = randomUUID();
    await database
      .insertInto('profile.profiles')
      .values({
        id: profileId,
        user_id: userId,
        name: 'Candidate fixture',
        birth_year: profile.birthYear,
        gender_option_id: profile.genderOptionId,
        gender_preference_id: profile.genderPreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: profile.cityId ?? defaultCityId,
        highlight: 'Candidate fixture',
        bio: null,
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (profile.primaryPhoto) {
      const assetId = await seedValidMedia(database, userId);
      await database
        .insertInto('media.profile_photos')
        .values({
          id: randomUUID(),
          profile_id: profileId,
          asset_id: assetId,
          status: 'visible',
          is_primary: true,
          display_order: 0,
          created_at: now,
          updated_at: now,
          hidden_at: null,
          deleted_at: null,
        })
        .execute();
    }
  }
  return userId;
}

function query(
  userId: string,
  mode: GetNextExploreCandidateQuery['mode'],
): GetNextExploreCandidateQuery {
  return { actor: { kind: 'user', userId }, requestId: randomUUID(), mode };
}

function generated(at = new Date()): Readonly<{
  deliveryId: string;
  eventId: string;
  reservedAt: Date;
}> {
  return { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: at };
}

describe.skipIf(databaseUrl === undefined)('M3 candidate reservation persistence', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('selects only a reciprocal visible candidate and replays one live reservation under race', async () => {
    const currentYear = new Date().getUTCFullYear();
    const isolatedCityId = randomUUID();
    const cityCode = `test_${isolatedCityId.replaceAll('-', '')}`;
    await database
      .insertInto('catalog.cities')
      .values({
        id: isolatedCityId,
        province_id: provinceId,
        code: cityCode,
        label_key: `catalog.city.${cityCode}`,
        display_order: 999,
      })
      .execute();
    const viewerId = await createUser(database, 'active', {
      genderOptionId: manGenderId,
      genderPreferenceId: womenPreferenceId,
      birthYear: currentYear - 32,
      primaryPhoto: false,
      cityId: isolatedCityId,
    });
    const targetId = await createUser(database, 'active', {
      genderOptionId: womanGenderId,
      genderPreferenceId: menPreferenceId,
      birthYear: currentYear - 30,
      primaryPhoto: true,
      cityId: isolatedCityId,
    });
    await createUser(database, 'active', {
      genderOptionId: womanGenderId,
      genderPreferenceId: womenPreferenceId,
      birthYear: currentYear - 30,
      primaryPhoto: true,
      cityId: isolatedCityId,
    });

    const store = new PostgresCandidateReservationStore(database);
    const requests = await Promise.all([
      store.reserveNext(query(viewerId, 'explore'), generated()),
      store.reserveNext(query(viewerId, 'explore'), generated()),
    ]);
    expect(requests[0]).toMatchObject({
      targetUserId: targetId,
      mode: 'explore',
      filterVersion: 1,
    });
    expect(requests[1]).toEqual(requests[0]);
    const reservations = await database
      .selectFrom('discovery.candidate_deliveries')
      .select(['id', 'target_user_id', 'state'])
      .where('viewer_user_id', '=', viewerId)
      .execute();
    expect(reservations).toEqual([
      { id: requests[0]!.deliveryId, target_user_id: targetId, state: 'reserved' },
    ]);
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('id')
      .where('aggregate_id', '=', requests[0]!.deliveryId)
      .where('event_type', '=', 'discovery.candidate-reserved.v1')
      .execute();
    expect(events).toHaveLength(1);
  });

  it('ignores viewer Profile facts for Guest Preview and refuses a new reservation at the limit', async () => {
    const currentYear = new Date().getUTCFullYear();
    const targetId = await createUser(database, 'active', {
      genderOptionId: womanGenderId,
      genderPreferenceId: menPreferenceId,
      birthYear: currentYear - 30,
      primaryPhoto: true,
    });
    const guestId = await createUser(database, 'guest');
    const limitedGuestId = await createUser(database, 'guest', undefined, 10);
    const store = new PostgresCandidateReservationStore(database);

    const reservation = await store.reserveNext(query(guestId, 'guest_preview'), generated());
    expect(reservation).toMatchObject({ mode: 'guest_preview', filterVersion: 1 });
    expect(reservation?.targetUserId).toBeTruthy();
    expect(targetId).toBeTruthy();
    await expect(
      store.reserveNext(query(limitedGuestId, 'guest_preview'), generated()),
    ).rejects.toMatchObject({ code: 'guest_preview_limit_reached' });
  });
});
