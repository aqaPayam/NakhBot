import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createReportPhoto, createReportUser } from './testing/report-fixture.js';
import { retainPhotoEvidenceInTransaction } from './photo-evidence-retention-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('media-owned exact-photo retention', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 6,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  it('returns only the exact thumbnail digest and opaque reference, and rolls back the hold with its transaction', async () => {
    const photoId = await createReportPhoto(database, await createReportUser(database, true)),
      evidenceId = randomUUID();
    await expect(
      database.transaction().execute(async (tx) => {
        const content = await retainPhotoEvidenceInTransaction(tx, { photoId, evidenceId });
        const source = await tx
          .selectFrom('media.profile_photos as photo')
          .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'photo.asset_id')
          .select(['variant.sha256', 'variant.storage_key'])
          .where('photo.id', '=', photoId)
          .where('variant.variant_type', '=', 'thumbnail')
          .executeTakeFirstOrThrow();
        expect(content).toEqual({
          evidenceType: 'photo',
          evidenceObjectRef: `v1.pe.${evidenceId}`,
          contentSha256: source.sha256.toString('hex'),
          primary: true,
        });
        expect(JSON.stringify(content)).not.toContain(source.storage_key);
        expect(
          await tx
            .selectFrom('media.report_photo_evidence_holds')
            .selectAll()
            .where('report_evidence_id', '=', evidenceId)
            .execute(),
        ).toHaveLength(1);
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .selectAll()
        .where('report_evidence_id', '=', evidenceId)
        .execute(),
    ).toHaveLength(0);
  });
  it('cannot commit without governing evidence, cannot rewrite a hold, and rejects an unavailable thumbnail', async () => {
    const photoId = await createReportPhoto(database, await createReportUser(database, true)),
      evidenceId = randomUUID();
    await expect(
      database
        .transaction()
        .execute((tx) => retainPhotoEvidenceInTransaction(tx, { photoId, evidenceId })),
    ).rejects.toThrow();
    await expect(
      database.transaction().execute(async (tx) => {
        await retainPhotoEvidenceInTransaction(tx, { photoId, evidenceId });
        await tx
          .updateTable('media.report_photo_evidence_holds')
          .set({ captured_primary: false })
          .where('report_evidence_id', '=', evidenceId)
          .execute();
      }),
    ).rejects.toThrow('append-only');
    const photo = await database
      .selectFrom('media.profile_photos')
      .select('asset_id')
      .where('id', '=', photoId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('media.photo_variants')
      .set({ deleted_at: new Date() })
      .where('asset_id', '=', photo.asset_id)
      .execute();
    await expect(
      database
        .transaction()
        .execute((tx) => retainPhotoEvidenceInTransaction(tx, { photoId, evidenceId })),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
  });
});
