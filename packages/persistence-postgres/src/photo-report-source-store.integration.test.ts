import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportTokens } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createReportLike, createReportPhoto, createReportUser } from './testing/report-fixture.js';
import {
  PostgresPreparePhotoReportEvidenceHandler,
  resolvePhotoReportSource,
} from './photo-report-source-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('selected-photo report preparation', () => {
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
  it('binds an opaque photo intent to the exact related target and rejects substituted photos and outsiders', async () => {
    const reporter = await createReportUser(database),
      target = await createReportUser(database, true),
      outsider = await createReportUser(database, true);
    const photoId = await createReportPhoto(database, target),
      otherPhoto = await createReportPhoto(database, outsider);
    const source = {
      kind: 'received_like' as const,
      referenceId: await createReportLike(database, reporter, target),
      photoId,
    };
    const values = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 78),
    );
    const actor = { kind: 'user' as const, userId: reporter },
      handler = new PostgresPreparePhotoReportEvidenceHandler(database, tokens);
    const query = {
      actor,
      requestId: randomUUID(),
      requestedEvidenceTypes: ['photo' as const],
      sourceActionToken: (await tokens.issueSource(reporter, source)).token,
    };
    const prepared = await handler.execute(query, actor);
    expect(await tokens.resolveIntent(prepared.evidenceIntentToken, reporter)).toEqual({
      source,
      targetUserId: target,
      evidence: [{ evidenceType: 'photo', referenceId: photoId }],
    });
    for (const id of [reporter, target, photoId, source.referenceId])
      expect(JSON.stringify(prepared)).not.toContain(id);
    expect(await tokens.resolveIntent(prepared.evidenceIntentToken, outsider)).toBeUndefined();
    expect(
      await resolvePhotoReportSource(database, reporter, { ...source, photoId: otherPhoto }),
    ).toBeUndefined();
    expect(await resolvePhotoReportSource(database, outsider, source)).toBeUndefined();
    expect(
      await resolvePhotoReportSource(database, reporter, {
        kind: source.kind,
        referenceId: source.referenceId,
      }),
    ).toBeUndefined();
    await expect(
      handler.execute({ ...query, requestedEvidenceTypes: ['profile', 'photo'] }, actor),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
  });
  it('rejects unavailable source media even when the relationship remains valid', async () => {
    const reporter = await createReportUser(database),
      target = await createReportUser(database, true);
    const photoId = await createReportPhoto(database, target),
      source = {
        kind: 'received_like' as const,
        referenceId: await createReportLike(database, reporter, target),
        photoId,
      };
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
    expect(await resolvePhotoReportSource(database, reporter, source)).toBeUndefined();
  });
});
