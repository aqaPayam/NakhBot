import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SaveExploreFilterCommand } from '@nakh/contracts';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresExploreFilterStore } from './explore-filter-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const womanGenderId = '20000000-0000-4000-8000-000000000002';
const manGenderId = '20000000-0000-4000-8000-000000000001';
const womenPreferenceId = '20000000-0000-4000-8000-000000000012';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

function command(
  userId: string,
  idempotencyKey: string,
  data: SaveExploreFilterCommand['data'],
): SaveExploreFilterCommand {
  return {
    commandId: randomUUID(),
    commandType: 'discovery.save-explore-filter',
    schemaVersion: 1,
    actor: { kind: 'user', userId },
    requestId: randomUUID(),
    idempotencyKey,
    occurredAt: '2026-09-17T00:00:00.000Z',
    locale: 'en',
    data,
  };
}

describe.skipIf(databaseUrl === undefined)('M3 Explore-filter persistence', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 4,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('saves atomically, replays idempotently, and enforces version and preference limits', async () => {
    const userId = randomUUID();
    const profileId = randomUUID();
    const now = new Date('2026-09-17T00:00:00.000Z');
    await database
      .insertInto('identity.users')
      .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
      .execute();
    await database
      .insertInto('identity.accounts')
      .values({
        user_id: userId,
        state: 'active',
        state_reason: null,
        state_changed_at: now,
      })
      .execute();
    await database
      .insertInto('profile.profiles')
      .values({
        id: profileId,
        user_id: userId,
        name: 'Explore fixture',
        birth_year: 1995,
        gender_option_id: manGenderId,
        gender_preference_id: womenPreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: cityId,
        highlight: 'Integration fixture',
        bio: null,
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const store = new PostgresExploreFilterStore(database);
    const first = command(userId, `filter:${randomUUID()}`, {
      targetGenderOptionIds: [womanGenderId],
      minAge: 24,
      maxAge: 36,
      cityId,
      relationshipGoalCode: 'serious_relationship',
    });
    const generated = { auditId: randomUUID(), eventId: randomUUID(), processedAt: now };

    await expect(store.saveFilter(first, generated)).resolves.toEqual({
      version: 1,
      targetGenderOptionIds: [womanGenderId],
      minAge: 24,
      maxAge: 36,
      cityId,
      relationshipGoalCode: 'serious_relationship',
      replayed: false,
    });
    await expect(
      store.saveFilter(first, {
        auditId: randomUUID(),
        eventId: randomUUID(),
        processedAt: new Date('2026-09-17T00:00:01.000Z'),
      }),
    ).resolves.toMatchObject({ version: 1, replayed: true });

    const filter = await database
      .selectFrom('discovery.explore_filters')
      .select(['version', 'min_age', 'max_age'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const genders = await database
      .selectFrom('discovery.explore_filter_genders')
      .select('gender_option_id')
      .where('user_id', '=', userId)
      .execute();
    const audit = await database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('command_id', '=', first.commandId)
      .execute();
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('id')
      .where('causation_id', '=', first.commandId)
      .execute();
    expect(filter).toEqual({ version: 1, min_age: 24, max_age: 36 });
    expect(genders).toEqual([{ gender_option_id: womanGenderId }]);
    expect(audit).toHaveLength(1);
    expect(events).toHaveLength(1);

    await expect(
      store.saveFilter(
        command(userId, `filter:${randomUUID()}`, {
          targetGenderOptionIds: [womanGenderId],
          minAge: 25,
          maxAge: 37,
          cityId,
          expectedVersion: 2,
        }),
        { auditId: randomUUID(), eventId: randomUUID(), processedAt: now },
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      store.saveFilter(
        command(userId, `filter:${randomUUID()}`, {
          targetGenderOptionIds: [manGenderId],
          minAge: 25,
          maxAge: 37,
          cityId,
          expectedVersion: 1,
        }),
        { auditId: randomUUID(), eventId: randomUUID(), processedAt: now },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'error.discovery.gender_filter_invalid',
    });
  });
});
