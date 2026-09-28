import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminCommandAttempt, PhotoAdminAction } from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { seedValidMedia } from './media-fixtures.js';
import { PostgresPhotoModerationWorkflow } from './photo-moderation-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const genderOptionId = '20000000-0000-4000-8000-000000000001';
const genderPreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createUser(database: NakhDatabase): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  return id;
}

async function createAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createUser(database);
  const adminUserId = randomUUID();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  const now = new Date();
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
      id: adminUserId,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_user_roles')
    .values({
      admin_user_id: adminUserId,
      role_code: 'moderator',
      assigned_by_admin_id: adminUserId,
      revoked_by_admin_id: null,
      revoked_at: null,
    })
    .execute();
  return adminUserId;
}

async function createProfileWithPhotos(
  database: NakhDatabase,
  count: number,
): Promise<
  Readonly<{ userId: string; profileId: string; photoIds: string[]; assetIds: string[] }>
> {
  const userId = await createUser(database);
  const now = new Date();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: userId, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  const profileId = randomUUID();
  await database
    .insertInto('profile.profiles')
    .values({
      id: profileId,
      user_id: userId,
      name: 'Photo moderation fixture',
      birth_year: now.getUTCFullYear() - 30,
      gender_option_id: genderOptionId,
      gender_preference_id: genderPreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Photo moderation fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const assetIds = await Promise.all(
    Array.from({ length: count }, () => seedValidMedia(database, userId)),
  );
  const photoIds = assetIds.map(() => randomUUID());
  await database
    .insertInto('media.profile_photos')
    .values(
      photoIds.map((id, index) => ({
        id,
        profile_id: profileId,
        asset_id: assetIds[index]!,
        status: 'visible' as const,
        is_primary: index === 0,
        display_order: index,
        created_at: now,
        updated_at: now,
        hidden_at: null,
        deleted_at: null,
      })),
    )
    .execute();
  return { userId, profileId, photoIds, assetIds };
}

function attempt(
  adminUserId: string,
  photoId: string,
  action: PhotoAdminAction,
  expectedTargetVersion: number,
): AdminCommandAttempt {
  const commandId = randomUUID();
  return {
    logId: randomUUID(),
    adminUserId,
    commandId,
    requestId: randomUUID(),
    requestDigest: digest(`${commandId}:${photoId}:${action}:${expectedTargetVersion}`),
    commandCode: 'moderation.apply-photo-action',
    requiredPermission: action,
    targetType: 'photo',
    targetId: photoId,
    expectedTargetVersion,
    reasonDigest: digest('confirmed photo policy violation'),
    metadata: {},
    correlationId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M7 photo moderation lifecycle', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 10,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('purges before hide/delete and preserves the M2 primary, completion, and cleanup lifecycle', async () => {
    const adminUserId = await createAdmin(database);
    const fixture = await createProfileWithPhotos(database, 3);
    const photoId = fixture.photoIds[0]!;
    const assetId = fixture.assetIds[0]!;
    const observedBeforePurge: string[] = [];
    const workflow = new PostgresPhotoModerationWorkflow(database, {
      execute: async (targetPhotoId) => {
        const photo = await database
          .selectFrom('media.profile_photos')
          .select('status')
          .where('id', '=', targetPhotoId)
          .executeTakeFirstOrThrow();
        observedBeforePurge.push(photo.status);
      },
    });
    const hide = attempt(adminUserId, photoId, 'hide_photo', 1);
    const restore = attempt(adminUserId, photoId, 'restore_photo', 2);
    const remove = attempt(adminUserId, photoId, 'delete_photo', 3);

    await expect(workflow.apply(hide, 'hide_photo')).resolves.toMatchObject({
      result: 'succeeded',
      value: {
        previousStatus: 'visible',
        nextStatus: 'hidden',
        wasPrimary: true,
        primaryPhotoId: fixture.photoIds[1],
        photoVersion: 2,
        profileVersion: 2,
        profileCompletion: 'complete',
      },
    });
    await expect(workflow.apply(restore, 'restore_photo')).resolves.toMatchObject({
      result: 'succeeded',
      value: {
        previousStatus: 'hidden',
        nextStatus: 'visible',
        wasPrimary: false,
        primaryPhotoId: fixture.photoIds[1],
        photoVersion: 3,
        profileVersion: 3,
        profileCompletion: 'complete',
      },
    });
    await expect(workflow.apply(remove, 'delete_photo')).resolves.toMatchObject({
      result: 'succeeded',
      value: {
        previousStatus: 'visible',
        nextStatus: 'deleted',
        photoVersion: 4,
        profileVersion: 4,
        profileCompletion: 'complete',
      },
    });
    expect(observedBeforePurge).toEqual(['visible', 'visible']);

    const photo = await database
      .selectFrom('media.profile_photos')
      .select(['status', 'is_primary', 'version', 'deleted_at'])
      .where('id', '=', photoId)
      .executeTakeFirstOrThrow();
    const primary = await database
      .selectFrom('media.profile_photos')
      .select('id')
      .where('profile_id', '=', fixture.profileId)
      .where('is_primary', '=', true)
      .executeTakeFirstOrThrow();
    const profile = await database
      .selectFrom('profile.profiles')
      .select(['completion_status', 'version'])
      .where('id', '=', fixture.profileId)
      .executeTakeFirstOrThrow();
    const asset = await database
      .selectFrom('media.media_assets')
      .select(['deleted_at', 'storage_deleted_at'])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
    const moderationRecords = await database
      .selectFrom('media.photo_moderation_records')
      .select('action')
      .where('photo_id', '=', photoId)
      .orderBy('occurred_at')
      .execute();
    const actions = await database
      .selectFrom('moderation.moderation_actions')
      .select(['action_type', 'audit_log_id'])
      .where('target_photo_id', '=', photoId)
      .orderBy('occurred_at')
      .execute();
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select('result')
      .where('command_id', 'in', [hide.commandId, restore.commandId, remove.commandId])
      .execute();

    expect(photo).toMatchObject({ status: 'deleted', is_primary: false, version: 4 });
    expect(photo.deleted_at).not.toBeNull();
    expect(primary.id).toBe(fixture.photoIds[1]);
    expect(profile).toEqual({ completion_status: 'complete', version: 4 });
    expect(asset.deleted_at).not.toBeNull();
    expect(asset.storage_deleted_at).toBeNull();
    expect(moderationRecords.map(({ action }) => action)).toEqual(['hide', 'restore', 'delete']);
    expect(actions.map(({ action_type }) => action_type)).toEqual([
      'hide_photo',
      'restore_photo',
      'delete_photo',
    ]);
    expect(new Set(actions.map(({ audit_log_id }) => audit_log_id)).size).toBe(3);
    expect(logs).toHaveLength(3);
    expect(logs.every(({ result }) => result === 'succeeded')).toBe(true);
  });

  it('serializes competing commands on the photo version and rolls back the stale effect', async () => {
    const adminUserId = await createAdmin(database);
    const fixture = await createProfileWithPhotos(database, 2);
    const photoId = fixture.photoIds[1]!;
    const workflow = new PostgresPhotoModerationWorkflow(database, {
      execute: () => Promise.resolve(),
    });
    const hide = attempt(adminUserId, photoId, 'hide_photo', 1);
    const remove = attempt(adminUserId, photoId, 'delete_photo', 1);
    const results = await Promise.all([
      workflow.apply(hide, 'hide_photo'),
      workflow.apply(remove, 'delete_photo'),
    ]);

    expect(results.filter(({ result }) => result === 'succeeded')).toHaveLength(1);
    expect(results.filter(({ safeCode }) => safeCode === 'version_conflict')).toHaveLength(1);
    expect(
      await database
        .selectFrom('media.photo_moderation_records')
        .select('id')
        .where('photo_id', '=', photoId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_photo_id', '=', photoId)
        .execute(),
    ).toHaveLength(1);
  });
});
