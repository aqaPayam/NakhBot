import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createRetainedReportPhoto,
  createReportPhoto,
  createReportUser,
} from './testing/report-fixture.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original Photo references and populated upgrade', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let deletedPhoto: string, held: Awaited<ReturnType<typeof createRetainedReportPhoto>>;
  let previousSource: unknown, previousHold: unknown;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_photo_reference');
    const directory = await mkdtemp(join(tmpdir(), 'nakh-photo-reference-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 93)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    held = await createRetainedReportPhoto(database);
    await createDeletionFixture(database, async (owner) => {
      const profile = await database
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', held.target)
        .executeTakeFirstOrThrow();
      await database
        .insertInto('profile.profiles')
        .values({ ...profile, id: randomUUID(), user_id: owner })
        .execute();
      deletedPhoto = await createReportPhoto(database, owner);
    });
    previousSource = await database
      .selectFrom('media.profile_photos')
      .selectAll()
      .where('id', '=', held.photoId)
      .executeTakeFirstOrThrow();
    previousHold = await database
      .selectFrom('media.report_photo_evidence_holds')
      .selectAll()
      .where('report_evidence_id', '=', held.evidenceId)
      .executeTakeFirstOrThrow();
    const upgrades = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(upgrades.flatMap((result) => result.applied)).toEqual([
      '000094_m8_photo_archival.sql',
      '000095_m8_evidence_checkpoint.sql',
      '000096_m8_product_batches.sql',
      '000097_m8_payment_lifecycle.sql',
      '000098_m8_media_delivery_authority.sql',
      '000099_m8_credit_lifecycle_provenance.sql',
      '000100_m8_deletion_lifecycle_binding.sql',
      '000101_m8_credit_epoch_partition.sql',
    ]);
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000094_m8_photo_archival.sql',
    );
  });
  afterAll(async () => {
    held?.key.fill(0);
    await database?.destroy();
    await isolated?.destroy();
  });
  it('backfills held and deleted-user sources without copying product fields or changing evidence', async () => {
    for (const id of [held.photoId, deletedPhoto]) {
      const source = await database
        .selectFrom('media.profile_photos')
        .select(['id', 'profile_id', 'asset_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(
        (
          await sql`SELECT * FROM media.photo_reference_anchors WHERE id=${id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([source]);
    }
    expect(
      await database
        .selectFrom('media.profile_photos')
        .selectAll()
        .where('id', '=', held.photoId)
        .executeTakeFirstOrThrow(),
    ).toEqual(previousSource);
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .selectAll()
        .where('report_evidence_id', '=', held.evidenceId)
        .executeTakeFirstOrThrow(),
    ).toEqual(previousHold);
    assertDeletionCatalogCoverage(await readDeletionCatalog(database));
  });
  it('requires exact references for new photos and denies orphan, reassignment and retained-reference deletion', async () => {
    const user = await createReportUser(database, true),
      photo = await createReportPhoto(database, user);
    const source = await database
      .selectFrom('media.profile_photos')
      .select(['id', 'profile_id', 'asset_id'])
      .where('id', '=', photo)
      .executeTakeFirstOrThrow();
    expect(
      (
        await sql`SELECT * FROM media.photo_reference_anchors WHERE id=${photo}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([source]);
    await expect(
      sql`UPDATE media.photo_reference_anchors SET profile_id=${randomUUID()}::uuid WHERE id=${photo}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM media.photo_reference_anchors WHERE id=${photo}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`INSERT INTO media.photo_reference_anchors VALUES(${randomUUID()}::uuid,${source.profile_id}::uuid,${randomUUID()}::uuid)`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rolls back a source whose mandatory anchor insert is suppressed', async () => {
    const user = await createReportUser(database, true);
    await sql`CREATE FUNCTION media.m8_suppress_photo_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER a_m8_suppress_photo_anchor BEFORE INSERT ON media.photo_reference_anchors FOR EACH ROW EXECUTE FUNCTION media.m8_suppress_photo_anchor()`.execute(
      database,
    );
    try {
      await expect(createReportPhoto(database, user)).rejects.toMatchObject({ code: '23514' });
      expect(
        await database
          .selectFrom('media.profile_photos as photo')
          .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
          .select('photo.id')
          .where('profile.user_id', '=', user)
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER a_m8_suppress_photo_anchor ON media.photo_reference_anchors`.execute(
        database,
      );
      await sql`DROP FUNCTION media.m8_suppress_photo_anchor()`.execute(database);
    }
  });
});
