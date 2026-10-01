import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeletePhotoMediaObjects } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresMediaCleanupStore } from './media-cleanup-store.js';
import { PostgresPhotoManagementStore } from './photo-management-store.js';
import { PostgresMediaObjectReferenceStore } from './media-object-reference-store.js';
import {
  createRetainedReportPhoto,
  createReportPhoto,
  createReportUser,
} from './testing/report-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('photo evidence cleanup protection', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 8,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  async function deleteOwn(target: string, photoId: string): Promise<void> {
    const store = new PostgresPhotoManagementStore(database),
      current = await store.listOwn(target);
    await store.mutateOwn({
      userId: target,
      expectedProfileVersion: current.profileVersion,
      action: { type: 'delete', photoId },
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
      profileEventId: randomUUID(),
      occurredAt: new Date(),
    });
  }
  it('permits product deletion but never calls object deletion for a held asset and rejects bypassing physical purge guards', async () => {
    const fixture = await createRetainedReportPhoto(database);
    await deleteOwn(fixture.target, fixture.photoId);
    const hold = await database
      .selectFrom('media.report_photo_evidence_holds')
      .selectAll()
      .where('report_evidence_id', '=', fixture.evidenceId)
      .executeTakeFirstOrThrow();
    const store = new PostgresMediaCleanupStore(database),
      remove = vi.fn(async () => {});
    await new DeletePhotoMediaObjects(store, { delete: remove }, 'test').execute(
      fixture.photoId,
      'held-worker',
    );
    expect(remove).not.toHaveBeenCalled();
    await expect(
      store.complete({
        assetId: hold.asset_id,
        deletionGeneration: 2,
        owner: 'held-worker',
        completedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      database
        .updateTable('media.media_assets')
        .set({
          cleanup_lease_owner: 'bypass',
          cleanup_lease_expires_at: new Date(Date.now() + 60000),
        })
        .where('id', '=', hold.asset_id)
        .execute(),
    ).rejects.toThrow('retained');
    await expect(
      database
        .updateTable('media.media_assets')
        .set({ storage_deleted_at: new Date() })
        .where('id', '=', hold.asset_id)
        .execute(),
    ).rejects.toThrow('retained');
    await expect(
      database
        .updateTable('media.photo_variants')
        .set({ storage_deleted_at: new Date() })
        .where('id', '=', hold.variant_id)
        .execute(),
    ).rejects.toThrow('retained');
    const variant = await database
      .selectFrom('media.photo_variants')
      .select(['storage_key', 'storage_deleted_at'])
      .where('id', '=', hold.variant_id)
      .executeTakeFirstOrThrow();
    expect(variant.storage_deleted_at).toBeNull();
    expect(
      await new PostgresMediaObjectReferenceStore(database).findReferenced([variant.storage_key]),
    ).toEqual(new Set([variant.storage_key]));
    await expect(
      database
        .deleteFrom('media.report_photo_evidence_holds')
        .where('report_evidence_id', '=', fixture.evidenceId)
        .execute(),
    ).rejects.toThrow('append-only');
  });
  it('still completes ordinary unheld object cleanup', async () => {
    const target = await createReportUser(database, true),
      photoId = await createReportPhoto(database, target);
    await deleteOwn(target, photoId);
    const remove = vi.fn(async () => {});
    await new DeletePhotoMediaObjects(
      new PostgresMediaCleanupStore(database),
      { delete: remove },
      'test',
    ).execute(photoId, 'ordinary-worker');
    expect(remove).toHaveBeenCalledTimes(3);
    const asset = await database
      .selectFrom('media.media_assets as asset')
      .innerJoin('media.profile_photos as photo', 'photo.asset_id', 'asset.id')
      .select('asset.storage_deleted_at')
      .where('photo.id', '=', photoId)
      .executeTakeFirstOrThrow();
    expect(asset.storage_deleted_at).not.toBeNull();
  });
});
