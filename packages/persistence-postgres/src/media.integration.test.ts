import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnsureBlurredPreview, type BeginMediaIngestionWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresMediaStore } from './media-store.js';
import { PostgresMediaValidationStore } from './media-validation-store.js';
import { PostgresMediaDeliveryAuthorization } from './media-delivery-authorization.js';
import { PostgresMediaDeliveryPathStore } from './media-delivery-path-store.js';
import { PostgresMediaCleanupStore } from './media-cleanup-store.js';
import { PostgresMediaObjectReferenceStore } from './media-object-reference-store.js';
import { PostgresBlurGenerationStore } from './blur-generation-store.js';
import { PostgresPhotoManagementStore } from './photo-management-store.js';
import { PostgresProfileMediaEligibility, profilePhotosAreEligible } from './media-eligibility.js';
import { seedValidMedia } from './media-fixtures.js';
import { SystemIdGenerator } from './foundation-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

function write(userId: string): BeginMediaIngestionWrite {
  return {
    assetId: randomUUID(),
    auditId: randomUUID(),
    eventId: randomUUID(),
    transportMetadataCiphertext: Buffer.from('synthetic-encrypted-fixture'),
    command: {
      commandId: randomUUID(),
      commandType: 'media.begin-telegram-photo-ingestion',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: '2020-01-01T00:00:00.000Z',
      locale: 'en',
      data: {
        telegramFileId: 'synthetic-file',
        telegramFileUniqueId: 'synthetic-unique',
        declaredSizeBytes: 1024,
        declaredMediaType: 'image/jpeg',
      },
    },
  };
}

describe.skipIf(databaseUrl === undefined)('M2 PostgreSQL media persistence', () => {
  let database: NakhDatabase;
  let store: PostgresMediaStore;
  let validation: PostgresMediaValidationStore;
  let photoManagement: PostgresPhotoManagementStore;
  let delivery: PostgresMediaDeliveryAuthorization;
  let blur: PostgresBlurGenerationStore;
  let deliveryPaths: PostgresMediaDeliveryPathStore;
  let cleanup: PostgresMediaCleanupStore;
  let objectReferences: PostgresMediaObjectReferenceStore;
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 25,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    store = new PostgresMediaStore(database, 'test', {
      decrypt: () => Promise.resolve({ telegramFileId: 'synthetic-file' }),
    });
    validation = new PostgresMediaValidationStore(database, 'test');
    photoManagement = new PostgresPhotoManagementStore(database);
    delivery = new PostgresMediaDeliveryAuthorization(database);
    blur = new PostgresBlurGenerationStore(database, 'test');
    deliveryPaths = new PostgresMediaDeliveryPathStore(database);
    cleanup = new PostgresMediaCleanupStore(database);
    objectReferences = new PostgresMediaObjectReferenceStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
  });

  async function user(): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await database
      .insertInto('identity.users')
      .values({ id, last_activity_at: now, created_at: now, updated_at: now })
      .execute();
    await database
      .insertInto('identity.accounts')
      .values({ user_id: id, state: 'incomplete', state_reason: null, state_changed_at: now })
      .execute();
    return id;
  }

  async function profile(userId: string): Promise<string> {
    const gender = await database
      .selectFrom('catalog.gender_options')
      .select('id')
      .where('code', '=', 'man')
      .executeTakeFirstOrThrow();
    const preference = await database
      .selectFrom('catalog.gender_preferences')
      .select('id')
      .where('code', '=', 'women')
      .executeTakeFirstOrThrow();
    const goal = await database
      .selectFrom('catalog.relationship_goals')
      .select('id')
      .where('code', '=', 'marriage')
      .executeTakeFirstOrThrow();
    const location = await database
      .selectFrom('catalog.cities as city')
      .innerJoin('catalog.provinces as province', 'province.id', 'city.province_id')
      .select(['city.id', 'province.id as province', 'province.country_id'])
      .where('city.code', '=', 'tehran')
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    const now = new Date();
    await database
      .insertInto('profile.profiles')
      .values({
        id,
        user_id: userId,
        name: 'Fixture',
        birth_year: 2000,
        gender_option_id: gender.id,
        gender_preference_id: preference.id,
        relationship_goal_id: goal.id,
        country_id: location.country_id,
        province_id: location.province,
        city_id: location.id,
        highlight: 'Fixture',
        bio: null,
        completion_status: 'incomplete',
        completed_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  async function assign(
    profileId: string,
    assetId: string,
    order: number,
    primary = false,
  ): Promise<void> {
    const now = new Date();
    await database
      .insertInto('media.profile_photos')
      .values({
        id: randomUUID(),
        profile_id: profileId,
        asset_id: assetId,
        status: 'visible',
        is_primary: primary,
        display_order: order,
        created_at: now,
        updated_at: now,
        hidden_at: null,
        deleted_at: null,
      })
      .execute();
  }

  it('admits only 20 concurrent attempts using server time, including coarse rejections', async () => {
    const userId = await user();
    const rejected = write(userId);
    rejected.command.data.declaredSizeBytes = 10485761;
    await expect(store.beginTelegramIngestion(rejected)).resolves.toMatchObject({
      validationState: 'rejected',
      errorCode: 'media_too_large',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () => store.beginTelegramIngestion(write(userId))),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(19);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'photo_upload_limit_reached' });
    const attempts = await database
      .selectFrom('media.media_assets')
      .selectAll()
      .where('owner_user_id', '=', userId)
      .execute();
    expect(attempts).toHaveLength(20);
    expect(attempts.every((asset) => asset.attempted_at.getFullYear() > 2020)).toBe(true);
    const replay = await store.beginTelegramIngestion({ ...rejected, assetId: randomUUID() });
    expect(replay).toMatchObject({
      assetId: rejected.assetId,
      replayed: true,
      validationState: 'rejected',
    });
  });

  it('releases attempt capacity after 24 hours without trusting client time', async () => {
    const id = await user();
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await Promise.all(
      Array.from({ length: 20 }, () => seedValidMedia(database, id, randomUUID(), false, expired)),
    );
    await expect(store.beginTelegramIngestion(write(id))).resolves.toMatchObject({
      validationState: 'pending',
    });
  });

  it('records quarantine once, replays matching facts, and rejects later corruption or rejection', async () => {
    const input = write(await user());
    await store.beginTelegramIngestion(input);
    const completion = {
      assetId: input.assetId,
      bytes: 3,
      sha256: 'a'.repeat(64),
      uploadedAt: new Date(),
      owner: 'worker-a',
      scannerVersion: 'scanner-1',
      signatureVersion: 'signatures-1',
      scannedAt: new Date(),
    };
    await store.claimPendingQuarantine({
      assetId: input.assetId,
      owner: 'worker-a',
      leaseMs: 60_000,
    });
    await store.markQuarantineUploaded(completion);
    await expect(
      store.claimPendingQuarantine({ assetId: input.assetId, owner: 'worker-b', leaseMs: 60_000 }),
    ).resolves.toMatchObject({
      completed: { bytes: 3, sha256: 'a'.repeat(64) },
    });
    const cleared = await database
      .selectFrom('media.media_assets')
      .select('transport_metadata_ciphertext')
      .where('id', '=', input.assetId)
      .executeTakeFirstOrThrow();
    expect(cleared.transport_metadata_ciphertext).toBeNull();
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', input.assetId)
        .where('event_type', '=', 'media.quarantine-uploaded.v1')
        .execute(),
    ).toHaveLength(1);
    await store.markQuarantineUploaded({ ...completion, uploadedAt: new Date(Date.now() + 1000) });
    await expect(store.markQuarantineUploaded({ ...completion, bytes: 4 })).rejects.toMatchObject({
      code: 'media_invalid_state',
    });
    await expect(
      store.markDownloadRejected({
        assetId: input.assetId,
        errorCode: 'media_download_invalid',
        failedAt: new Date(),
        owner: 'worker-b',
      }),
    ).rejects.toMatchObject({ code: 'media_invalid_state' });
    for (const change of [
      { quarantine_size_bytes: 4 },
      { quarantine_sha256: Buffer.alloc(32, 2) },
      { quarantine_key: 'quarantine/test/changed/original' },
      { quarantine_uploaded_at: null },
    ]) {
      await expect(
        database
          .updateTable('media.media_assets')
          .set(change)
          .where('id', '=', input.assetId)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('fences concurrent quarantine workers and permits release or expired-lease recovery', async () => {
    const input = write(await user());
    await store.beginTelegramIngestion(input);
    const claims = await Promise.all([
      store.claimPendingQuarantine({ assetId: input.assetId, owner: 'worker-a', leaseMs: 60_000 }),
      store.claimPendingQuarantine({ assetId: input.assetId, owner: 'worker-b', leaseMs: 60_000 }),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    const winner = claims[0] === undefined ? 'worker-b' : 'worker-a';
    const loser = winner === 'worker-a' ? 'worker-b' : 'worker-a';
    await expect(
      store.markQuarantineUploaded({
        assetId: input.assetId,
        bytes: 3,
        sha256: 'a'.repeat(64),
        uploadedAt: new Date(),
        owner: loser,
        scannerVersion: 'scanner-1',
        signatureVersion: 'signatures-1',
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'media_invalid_state' });
    await store.releaseQuarantineClaim(input.assetId, winner);
    await expect(
      store.claimPendingQuarantine({ assetId: input.assetId, owner: loser, leaseMs: 60_000 }),
    ).resolves.toMatchObject({ assetId: input.assetId });
    await database
      .updateTable('media.media_assets')
      .set({ ingestion_lease_expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', input.assetId)
      .execute();
    await expect(
      store.claimPendingQuarantine({ assetId: input.assetId, owner: winner, leaseMs: 60_000 }),
    ).resolves.toMatchObject({ assetId: input.assetId });
  });

  it('publishes verified renditions atomically and rejects a normalized duplicate', async () => {
    const userId = await user();
    const originalSha256 = 'a'.repeat(64);
    const normalizedSha256 = 'b'.repeat(64);
    const createQuarantined = async (): Promise<string> => {
      const input = write(userId);
      await store.beginTelegramIngestion(input);
      await store.claimPendingQuarantine({
        assetId: input.assetId,
        owner: 'ingestion',
        leaseMs: 60_000,
      });
      await store.markQuarantineUploaded({
        assetId: input.assetId,
        owner: 'ingestion',
        bytes: 3,
        sha256: originalSha256,
        uploadedAt: new Date(),
        scannerVersion: 'scanner-1',
        signatureVersion: 'signatures-1',
        scannedAt: new Date(),
      });
      return input.assetId;
    };
    const first = await createQuarantined();
    const claims = await Promise.all([
      validation.claim({ assetId: first, owner: 'validator-a', leaseMs: 60_000 }),
      validation.claim({ assetId: first, owner: 'validator-b', leaseMs: 60_000 }),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    const asset = await database
      .selectFrom('media.media_assets')
      .select('validation_lease_owner')
      .where('id', '=', first)
      .executeTakeFirstOrThrow();
    const owner = asset.validation_lease_owner!;
    const complete = (
      assetId: string,
      claimOwner: string,
    ): Promise<'valid' | 'duplicate_media' | 'photo_limit_reached'> =>
      validation.complete({
        assetId,
        owner: claimOwner,
        detectedMediaType: 'image/jpeg',
        sizeBytes: 3,
        width: 800,
        height: 700,
        originalSha256,
        normalizedSha256,
        validatedKey: `validated/test/${assetId}/original`,
        thumbnailKey: `variants/test/${assetId}/thumbnail-v1.webp`,
        thumbnailBytes: 2,
        thumbnailSha256: 'c'.repeat(64),
        completedAt: new Date(),
      });
    const second = await createQuarantined();
    await validation.claim({ assetId: second, owner: 'validator-c', leaseMs: 60_000 });
    const outcomes = await Promise.all([complete(first, owner), complete(second, 'validator-c')]);
    expect(outcomes.sort()).toEqual(['duplicate_media', 'valid']);
    const facts = await database
      .selectFrom('media.media_assets')
      .select(['id', 'validation_state', 'error_code', 'validated_key'])
      .where('id', 'in', [first, second])
      .execute();
    expect(facts.filter((fact) => fact.validation_state === 'valid')).toHaveLength(1);
    expect(facts.filter((fact) => fact.error_code === 'duplicate_media')).toHaveLength(1);
    expect(
      await database
        .selectFrom('media.photo_variants')
        .select('id')
        .where('asset_id', 'in', [first, second])
        .execute(),
    ).toHaveLength(1);
  });

  it('rejects partial quarantine facts and deleted-asset completion', async () => {
    const input = write(await user());
    await store.beginTelegramIngestion(input);
    await expect(
      database
        .updateTable('media.media_assets')
        .set({ quarantine_size_bytes: 3 })
        .where('id', '=', input.assetId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await database
      .updateTable('media.media_assets')
      .set({ deleted_at: new Date() })
      .where('id', '=', input.assetId)
      .execute();
    await store.claimPendingQuarantine({
      assetId: input.assetId,
      owner: 'worker-a',
      leaseMs: 60_000,
    });
    await expect(
      store.markQuarantineUploaded({
        assetId: input.assetId,
        bytes: 3,
        sha256: 'a'.repeat(64),
        uploadedAt: new Date(),
        owner: 'worker-a',
        scannerVersion: 'scanner-1',
        signatureVersion: 'signatures-1',
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'media_invalid_state' });
  });

  it('replays concurrently without additional assets, audit rows, or outbox events', async () => {
    const input = write(await user());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.beginTelegramIngestion(input)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.assetId)).size).toBe(1);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('command_id', '=', input.command.commandId)
        .execute(),
    ).toHaveLength(1);
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('causation_id', '=', input.command.commandId)
      .execute();
    expect(events).toEqual([{ payload: { assetId: input.assetId, validationState: 'pending' } }]);
    await expect(
      store.beginTelegramIngestion({
        ...input,
        command: { ...input.command, data: { ...input.command.data, telegramFileId: 'changed' } },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rolls back the attempt and idempotency response if outbox insertion fails', async () => {
    const initial = write(await user());
    await store.beginTelegramIngestion(initial);
    const input = { ...write(initial.command.actor.userId), eventId: initial.eventId };
    await expect(store.beginTelegramIngestion(input)).rejects.toBeDefined();
    expect(
      await database
        .selectFrom('media.media_assets')
        .select('id')
        .where('id', '=', input.assetId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('id', '=', input.command.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('id', '=', input.auditId)
        .execute(),
    ).toHaveLength(0);
  });

  it('does not accept uploads for guests, banned accounts, or forged system actors', async () => {
    const id = await user();
    for (const state of ['guest', 'banned', 'deleted'] as const) {
      await database
        .updateTable('identity.accounts')
        .set({ state })
        .where('user_id', '=', id)
        .execute();
      await expect(store.beginTelegramIngestion(write(id))).rejects.toMatchObject({
        code: 'capability_denied',
      });
    }
    const input = write(id);
    await expect(
      store.beginTelegramIngestion({
        ...input,
        command: { ...input.command, actor: { kind: 'system', userId: id } },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('allows restricted users to upload replacement photos as permitted by edit_profile', async () => {
    const id = await user();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'restricted' })
      .where('user_id', '=', id)
      .execute();
    await expect(store.beginTelegramIngestion(write(id))).resolves.toMatchObject({
      validationState: 'pending',
    });
  });

  it('requires owned, distinct, valid assets with a verified thumbnail', async () => {
    const id = await user();
    const first = await seedValidMedia(database, id);
    const second = await seedValidMedia(database, id);
    const port = new PostgresProfileMediaEligibility(database, new SystemIdGenerator());
    await expect(
      port.issueProof(id, { primaryMediaAssetId: first, additionalMediaAssetIds: [second] }),
    ).resolves.toMatchObject({ userId: id, acceptedMediaAssetIds: [first, second] });
    const missingThumbnail = await seedValidMedia(database, id, randomUUID(), false);
    const foreign = await seedValidMedia(database, await user());
    const pending = write(id);
    await store.beginTelegramIngestion(pending);
    for (const other of [first, missingThumbnail, foreign, pending.assetId, randomUUID()]) {
      await expect(
        port.issueProof(id, { primaryMediaAssetId: first, additionalMediaAssetIds: [other] }),
      ).rejects.toMatchObject({ code: 'media_not_eligible' });
    }
    await database
      .updateTable('media.media_assets')
      .set({ deleted_at: new Date() })
      .where('id', '=', second)
      .execute();
    await expect(
      port.issueProof(id, { primaryMediaAssetId: first, additionalMediaAssetIds: [second] }),
    ).rejects.toMatchObject({ code: 'media_not_eligible' });
  });

  it('ACC-009/M2-CONCURRENCY serializes seven assignments to six saved slots', async () => {
    const id = await user();
    const profileId = await profile(id);
    const assets = await Promise.all(Array.from({ length: 7 }, () => seedValidMedia(database, id)));
    const results = await Promise.allSettled(
      assets.map((asset, order) => assign(profileId, asset, order)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await database
        .selectFrom('media.profile_photos')
        .select('id')
        .where('profile_id', '=', profileId)
        .execute(),
    ).toHaveLength(6);
  });

  it('protects primary uniqueness, ownership, thumbnail readiness, and completion checks', async () => {
    const id = await user();
    const profileId = await profile(id);
    const first = await seedValidMedia(database, id);
    const second = await seedValidMedia(database, id);
    await assign(profileId, first, 0, true);
    await expect(assign(profileId, second, 1, true)).rejects.toMatchObject({ code: '23505' });
    await assign(profileId, second, 1);
    expect(await profilePhotosAreEligible(database, profileId)).toBe(true);
    const foreign = await seedValidMedia(database, await user());
    await expect(assign(profileId, foreign, 2)).rejects.toMatchObject({ code: '23514' });
    const noThumbnail = await seedValidMedia(database, id, randomUUID(), false);
    await expect(assign(profileId, noThumbnail, 2)).rejects.toMatchObject({ code: '23514' });
    await database
      .updateTable('media.profile_photos')
      .set({ status: 'hidden', hidden_at: new Date() })
      .where('asset_id', '=', second)
      .execute();
    expect(await profilePhotosAreEligible(database, profileId)).toBe(false);
  });

  it('ACC-008/M2-E2E and ACC-012/M2-LIFECYCLE preserve visibility invariants', async () => {
    const userId = await user();
    const profileId = await profile(userId);
    const assets = await Promise.all(
      Array.from({ length: 3 }, () => seedValidMedia(database, userId)),
    );
    for (const [order, assetId] of assets.entries())
      await assign(profileId, assetId, order, order === 0);
    const completedAt = new Date();
    await database
      .updateTable('profile.profiles')
      .set({
        completion_status: 'complete',
        ever_completed: true,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .where('id', '=', profileId)
      .execute();
    const initial = await photoManagement.listOwn(userId);
    const photoIds = initial.photos.map((photo) => photo.id);
    const mutate = (
      expectedProfileVersion: number,
      action: Parameters<PostgresPhotoManagementStore['mutateOwn']>[0]['action'],
    ): ReturnType<PostgresPhotoManagementStore['mutateOwn']> =>
      photoManagement.mutateOwn({
        userId,
        expectedProfileVersion,
        action,
        auditId: randomUUID(),
        eventId: randomUUID(),
        profileEventId: randomUUID(),
        occurredAt: new Date(),
      });
    const reordered = await mutate(initial.profileVersion, {
      type: 'reorder',
      orderedPhotoIds: [...photoIds].reverse(),
    });
    expect(reordered.photos.map((photo) => photo.id)).toEqual([...photoIds].reverse());
    const selected = await mutate(reordered.profileVersion, {
      type: 'select_primary',
      photoId: photoIds[1]!,
    });
    expect(selected.photos.filter((photo) => photo.isPrimary).map((photo) => photo.id)).toEqual([
      photoIds[1],
    ]);
    await expect(
      mutate(selected.profileVersion, { type: 'delete', photoId: photoIds[1]! }),
    ).rejects.toMatchObject({ code: 'photo_primary_delete_denied' });
    await expect(
      mutate(initial.profileVersion, {
        type: 'delete',
        photoId: photoIds[0]!,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const afterDelete = await mutate(selected.profileVersion, {
      type: 'delete',
      photoId: photoIds[0]!,
    });
    expect(afterDelete.photos).toHaveLength(2);

    const adminUserId = await user();
    const adminId = randomUUID();
    await database
      .insertInto('administration.admin_users')
      .values({
        id: adminId,
        user_id: adminUserId,
        telegram_user_id: String(Date.now()),
        disabled_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const moderate = (
      action: 'hide' | 'restore' | 'delete',
    ): ReturnType<PostgresPhotoManagementStore['moderate']> =>
      photoManagement.moderate({
        adminUserId,
        photoId: photoIds[1]!,
        action,
        reasonCode: 'confirmed_violation',
        moderationId: randomUUID(),
        auditId: randomUUID(),
        eventId: randomUUID(),
        profileEventId: randomUUID(),
        occurredAt: new Date(),
      });
    await moderate('hide');
    const hidden = await photoManagement.listOwn(userId);
    expect(hidden.photos.find((photo) => photo.id === photoIds[1])).toMatchObject({
      status: 'hidden',
      isPrimary: false,
    });
    expect(hidden.photos.filter((photo) => photo.isPrimary)).toHaveLength(1);
    expect(
      await database
        .selectFrom('profile.profiles')
        .select('completion_status')
        .where('id', '=', profileId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ completion_status: 'invalid' });
    await moderate('restore');
    expect(
      await database
        .selectFrom('profile.profiles')
        .select('completion_status')
        .where('id', '=', profileId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ completion_status: 'complete' });
    expect(
      await database
        .selectFrom('media.photo_moderation_records')
        .select('id')
        .where('photo_id', '=', photoIds[1]!)
        .execute(),
    ).toHaveLength(2);
  });

  it('serializes competing primary selections through the Profile version', async () => {
    const userId = await user();
    const profileId = await profile(userId);
    const assets = await Promise.all(
      Array.from({ length: 2 }, () => seedValidMedia(database, userId)),
    );
    await assign(profileId, assets[0]!, 0, true);
    await assign(profileId, assets[1]!, 1);
    const collection = await photoManagement.listOwn(userId);
    const writes = collection.photos.map((photo) =>
      photoManagement.mutateOwn({
        userId,
        expectedProfileVersion: collection.profileVersion,
        action: { type: 'select_primary', photoId: photo.id },
        auditId: randomUUID(),
        eventId: randomUUID(),
        profileEventId: randomUUID(),
        occurredAt: new Date(),
      }),
    );
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const final = await photoManagement.listOwn(userId);
    expect(final.photos.filter((photo) => photo.isPrimary)).toHaveLength(1);
  });

  it('authorizes owner preview without exposing keys and denies cross-user access', async () => {
    const userId = await user();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active' })
      .where('user_id', '=', userId)
      .execute();
    const profileId = await profile(userId);
    const assetId = await seedValidMedia(database, userId);
    await assign(profileId, assetId, 0, true);
    const photo = await database
      .selectFrom('media.profile_photos')
      .select('id')
      .where('profile_id', '=', profileId)
      .executeTakeFirstOrThrow();
    await expect(
      delivery.authorize({
        actor: { kind: 'user', userId },
        photoId: photo.id,
        purpose: 'owner_preview',
        requestedVariant: 'thumbnail',
      }),
    ).resolves.toMatchObject({
      deliveryPath: `/media/${assetId}/thumbnail-v1.webp`,
      cachePolicy: 'private',
    });
    await expect(
      delivery.authorize({
        actor: { kind: 'user', userId: await user() },
        photoId: photo.id,
        purpose: 'owner_preview',
        requestedVariant: 'thumbnail',
      }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    await expect(
      delivery.authorize({
        actor: { kind: 'user', userId },
        photoId: photo.id,
        purpose: 'profile_card',
        requestedVariant: 'thumbnail',
      }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
  });

  it('publishes one deterministic blur under concurrency and denies a non-primary asset', async () => {
    const userId = await user();
    const profileId = await profile(userId);
    const assets = await Promise.all(
      Array.from({ length: 2 }, () => seedValidMedia(database, userId)),
    );
    await assign(profileId, assets[0]!, 0, true);
    await assign(profileId, assets[1]!, 1);
    const prepared = await blur.prepare(assets[0]!);
    expect(prepared).toMatchObject({
      status: 'pending',
      generation: {
        sourceKey: `validated/test/${assets[0]!}/original`,
        blurredKey: `variants/test/${assets[0]!}/blurred-preview-v1.webp`,
      },
    });
    const completion = {
      assetId: assets[0]!,
      blurredKey: `variants/test/${assets[0]!}/blurred-preview-v1.webp`,
      bytes: 123,
      sha256: 'a'.repeat(64),
      completedAt: new Date(),
    };
    await expect(
      Promise.all([blur.complete(completion), blur.complete(completion)]),
    ).resolves.toEqual([
      `/media/${assets[0]!}/blurred-preview-v1.webp`,
      `/media/${assets[0]!}/blurred-preview-v1.webp`,
    ]);
    expect(
      await database
        .selectFrom('media.photo_variants')
        .select('id')
        .where('asset_id', '=', assets[0]!)
        .where('variant_type', '=', 'blurred_preview')
        .execute(),
    ).toHaveLength(1);
    await expect(blur.prepare(assets[1]!)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
  });

  it('ACC-011/M2-FAILURE leaves the photo and Profile valid after blur failure', async () => {
    const userId = await user();
    const profileId = await profile(userId);
    const assets = await Promise.all(
      Array.from({ length: 2 }, () => seedValidMedia(database, userId)),
    );
    await assign(profileId, assets[0]!, 0, true);
    await assign(profileId, assets[1]!, 1);
    await database
      .updateTable('profile.profiles')
      .set({
        completion_status: 'complete',
        ever_completed: true,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', profileId)
      .execute();
    const handler = new EnsureBlurredPreview(
      blur,
      {
        get: () =>
          Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield new Uint8Array([1]);
            })(),
          ),
        put: () => Promise.reject(new Error('storage unavailable')),
        delete: () => Promise.resolve(),
      },
      { transform: () => Promise.resolve(new Uint8Array([2])) },
    );

    await expect(handler.execute(assets[0]!)).rejects.toThrow('storage unavailable');
    await expect(photoManagement.listOwn(userId)).resolves.toMatchObject({
      photos: [
        { status: 'visible', isPrimary: true },
        { status: 'visible', isPrimary: false },
      ],
    });
    await expect(
      database
        .selectFrom('profile.profiles')
        .select('completion_status')
        .where('id', '=', profileId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ completion_status: 'complete' });
    await expect(
      database
        .selectFrom('media.photo_variants')
        .select('id')
        .where('asset_id', '=', assets[0]!)
        .where('variant_type', '=', 'blurred_preview')
        .execute(),
    ).resolves.toEqual([]);
  });

  it('ACC-013/M2-PHOTO-DELETE revokes delivery and completes cleanup exactly once', async () => {
    const userId = await user();
    const profileId = await profile(userId);
    const assets = await Promise.all(
      Array.from({ length: 2 }, () => seedValidMedia(database, userId)),
    );
    await assign(profileId, assets[0]!, 0, true);
    await assign(profileId, assets[1]!, 1);
    const collection = await photoManagement.listOwn(userId);
    const deletedPhoto = collection.photos.find((photo) => !photo.isPrimary)!;
    await photoManagement.mutateOwn({
      userId,
      expectedProfileVersion: collection.profileVersion,
      action: { type: 'delete', photoId: deletedPhoto.id },
      auditId: randomUUID(),
      eventId: randomUUID(),
      profileEventId: randomUUID(),
      occurredAt: new Date(),
    });
    await expect(deliveryPaths.listDeliveryPaths(deletedPhoto.id)).resolves.toEqual([
      `/media/${assets[1]!}/thumbnail-v1.webp`,
    ]);
    await expect(
      delivery.authorize({
        actor: { kind: 'user', userId },
        photoId: deletedPhoto.id,
        purpose: 'owner_preview',
        requestedVariant: 'thumbnail',
      }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    const assetBeforeCleanup = await database
      .selectFrom('media.media_assets')
      .select(['deleted_at', 'storage_deleted_at'])
      .where('id', '=', assets[1]!)
      .executeTakeFirstOrThrow();
    const variantBeforeCleanup = await database
      .selectFrom('media.photo_variants')
      .select(['deleted_at', 'storage_deleted_at'])
      .where('asset_id', '=', assets[1]!)
      .executeTakeFirstOrThrow();
    expect(assetBeforeCleanup.deleted_at).not.toBeNull();
    expect(assetBeforeCleanup.storage_deleted_at).toBeNull();
    expect(variantBeforeCleanup.deleted_at).not.toBeNull();
    expect(variantBeforeCleanup.storage_deleted_at).toBeNull();
    await expect(
      objectReferences.findReferenced([
        `quarantine/test/${assets[1]!}/original`,
        `validated/test/${assets[1]!}/original`,
        `variants/test/${assets[1]!}/thumbnail-v1.webp`,
        `variants/test/30000000-0000-4000-8000-000000000003/thumbnail-v1.webp`,
      ]),
    ).resolves.toEqual(
      new Set([
        `quarantine/test/${assets[1]!}/original`,
        `validated/test/${assets[1]!}/original`,
        `variants/test/${assets[1]!}/thumbnail-v1.webp`,
      ]),
    );

    const contenders = Array.from({ length: 20 }, (_, index) => `cleanup-worker-${index}`);
    const claims = await Promise.all(
      contenders.map((owner) =>
        cleanup.claimPhoto({ photoId: deletedPhoto.id, owner, leaseMs: 60_000 }),
      ),
    );
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    const winnerIndex = claims.findIndex((claim) => claim !== undefined);
    const winner = contenders[winnerIndex]!;
    const plan = claims[winnerIndex]!;
    expect(plan).toMatchObject({
      assetId: assets[1],
      objectKeys: [
        `variants/test/${assets[1]!}/thumbnail-v1.webp`,
        `validated/test/${assets[1]!}/original`,
        `quarantine/test/${assets[1]!}/original`,
      ],
    });
    await expect(
      cleanup.claimPhoto({
        photoId: deletedPhoto.id,
        owner: 'cleanup-worker-late',
        leaseMs: 60_000,
      }),
    ).resolves.toBeUndefined();
    await database
      .updateTable('media.media_assets')
      .set({ cleanup_lease_expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', plan.assetId)
      .execute();
    await expect(
      cleanup.complete({
        assetId: plan.assetId,
        deletionGeneration: plan.deletionGeneration,
        owner: winner,
        completedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const recoveredPlan = await cleanup.claimPhoto({
      photoId: deletedPhoto.id,
      owner: 'cleanup-worker-recovery',
      leaseMs: 60_000,
    });
    expect(recoveredPlan).toEqual(plan);
    await cleanup.complete({
      assetId: recoveredPlan!.assetId,
      deletionGeneration: recoveredPlan!.deletionGeneration,
      owner: 'cleanup-worker-recovery',
      completedAt: new Date(),
    });
    await expect(
      cleanup.claimPhoto({
        photoId: deletedPhoto.id,
        owner: 'cleanup-worker-recovery',
        leaseMs: 60_000,
      }),
    ).resolves.toBeUndefined();
    const completed = await database
      .selectFrom('media.media_assets')
      .select(['storage_deleted_at', 'cleanup_lease_owner'])
      .where('id', '=', assets[1]!)
      .executeTakeFirstOrThrow();
    expect(completed.storage_deleted_at).not.toBeNull();
    expect(completed.cleanup_lease_owner).toBeNull();
  });

  it('refuses blur publication after the prepared asset stops being primary', async () => {
    const userId = await user();
    const profileId = await profile(userId);
    const assets = await Promise.all(
      Array.from({ length: 2 }, () => seedValidMedia(database, userId)),
    );
    await assign(profileId, assets[0]!, 0, true);
    await assign(profileId, assets[1]!, 1);
    await expect(blur.prepare(assets[0]!)).resolves.toMatchObject({ status: 'pending' });
    const collection = await photoManagement.listOwn(userId);
    const replacement = collection.photos.find((photo) => !photo.isPrimary)!;
    await photoManagement.mutateOwn({
      userId,
      expectedProfileVersion: collection.profileVersion,
      action: { type: 'select_primary', photoId: replacement.id },
      auditId: randomUUID(),
      eventId: randomUUID(),
      profileEventId: randomUUID(),
      occurredAt: new Date(),
    });
    await expect(
      blur.complete({
        assetId: assets[0]!,
        blurredKey: `variants/test/${assets[0]!}/blurred-preview-v1.webp`,
        bytes: 123,
        sha256: 'b'.repeat(64),
        completedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    expect(
      await database
        .selectFrom('media.photo_variants')
        .select('id')
        .where('asset_id', '=', assets[0]!)
        .where('variant_type', '=', 'blurred_preview')
        .execute(),
    ).toHaveLength(0);
  });

  it('rejects terminal-state rewrites, owner changes, and active normalized duplicates', async () => {
    const id = await user();
    const first = await seedValidMedia(database, id);
    const second = await seedValidMedia(database, id);
    const asset = await database
      .selectFrom('media.media_assets')
      .selectAll()
      .where('id', '=', first)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .updateTable('media.media_assets')
        .set({ owner_user_id: await user() })
        .where('id', '=', first)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database
        .updateTable('media.media_assets')
        .set({ validation_state: 'pending', terminal_at: null })
        .where('id', '=', first)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database
        .updateTable('media.media_assets')
        .set({ normalized_sha256: asset.normalized_sha256 })
        .where('id', '=', second)
        .execute(),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
