import { randomUUID } from 'node:crypto';
import type { NakhDatabase } from '../database.js';

export async function createReportUser(
  database: NakhDatabase,
  withProfile = false,
): Promise<string> {
  const id = randomUUID(),
    now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: id, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  if (withProfile)
    await database
      .insertInto('profile.profiles')
      .values({
        id: randomUUID(),
        user_id: id,
        name: 'Private report fixture',
        birth_year: 1995,
        gender_option_id: '20000000-0000-4000-8000-000000000001',
        gender_preference_id: '20000000-0000-4000-8000-000000000013',
        relationship_goal_id: '20000000-0000-4000-8000-000000000021',
        country_id: '20000000-0000-4000-8000-000000000101',
        province_id: '20000000-0000-4000-8000-000000000111',
        city_id: '20000000-0000-4000-8000-000000000121',
        highlight: 'Private highlight',
        bio: 'Private report bio',
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  return id;
}
export async function createReportLike(
  database: NakhDatabase,
  reporter: string,
  target: string,
): Promise<string> {
  const id = randomUUID();
  await database
    .insertInto('interaction.likes')
    .values({
      id,
      sender_user_id: target,
      receiver_user_id: reporter,
      status: 'active',
      created_at: new Date(),
      closed_at: null,
    })
    .execute();
  return id;
}

export async function createReportFixtureAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createReportUser(database),
    id = randomUUID(),
    now = new Date();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_users')
    .values({
      id,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}
