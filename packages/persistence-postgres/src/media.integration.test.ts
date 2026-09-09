import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BeginMediaIngestionWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresMediaStore } from './media-store.js';
import { PostgresMediaValidationStore } from './media-validation-store.js';
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
    await expect(complete(first, owner)).resolves.toBe('valid');
    const firstFacts = await database
      .selectFrom('media.media_assets')
      .selectAll()
      .where('id', '=', first)
      .executeTakeFirstOrThrow();
    expect(firstFacts).toMatchObject({
      validation_state: 'valid',
      validated_key: `validated/test/${first}/original`,
    });
    expect(
      await database
        .selectFrom('media.photo_variants')
        .select('id')
        .where('asset_id', '=', first)
        .execute(),
    ).toHaveLength(1);

    const second = await createQuarantined();
    await validation.claim({ assetId: second, owner: 'validator-c', leaseMs: 60_000 });
    await expect(complete(second, 'validator-c')).resolves.toBe('duplicate_media');
    expect(
      await database
        .selectFrom('media.media_assets')
        .select(['validation_state', 'error_code'])
        .where('id', '=', second)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      validation_state: 'rejected',
      error_code: 'duplicate_media',
    });
    expect(
      await database
        .selectFrom('media.photo_variants')
        .select('id')
        .where('asset_id', '=', second)
        .execute(),
    ).toHaveLength(0);
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

  it('serializes seven assignment inserts to six saved slots', async () => {
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
