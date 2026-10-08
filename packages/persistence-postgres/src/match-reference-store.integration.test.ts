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
  createReportMatch,
  createReportUnmatch,
  createReportUser,
} from './testing/report-fixture.js';
import { resolveUnmatchedReportSource } from './unmatched-report-source-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 minimal original Match references', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let owner: string, survivor: string, matchId: string;
  let originalMatch: unknown, originalUnmatch: unknown;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_match_reference');
    const directory = await mkdtemp(join(tmpdir(), 'nakh-match-reference-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 91)
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
    survivor = await createReportUser(database, true);
    const fixture = await createDeletionFixture(database, async (userId) => {
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${userId}::uuid`.execute(
        database,
      );
      matchId = (await createReportUnmatch(database, survivor, userId)).matchId;
    });
    owner = fixture.userId;
    originalMatch = await database
      .selectFrom('matching.matches')
      .selectAll()
      .where('id', '=', matchId)
      .executeTakeFirstOrThrow();
    originalUnmatch = await database
      .selectFrom('matching.unmatch_records')
      .selectAll()
      .where('match_id', '=', matchId)
      .executeTakeFirstOrThrow();
    const upgrades = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(upgrades.flatMap((result) => result.applied)).toEqual([
      '000092_m8_match_references.sql',
      '000093_m8_match_archival.sql',
    ]);
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000092_m8_match_references.sql',
    );
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function anchor(id: string): Promise<Record<string, unknown> | undefined> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM matching.match_reference_anchors WHERE id=${id}::uuid`.execute(database)
    ).rows[0];
  }
  it('backfills a deleted participant without changing the original Match or immutable Unmatch', async () => {
    const [low, high] = [owner, survivor].sort();
    expect(await anchor(matchId)).toEqual({ id: matchId, user_low_id: low, user_high_id: high });
    expect(
      await database
        .selectFrom('matching.matches')
        .selectAll()
        .where('id', '=', matchId)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalMatch);
    expect(
      await database
        .selectFrom('matching.unmatch_records')
        .selectAll()
        .where('match_id', '=', matchId)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalUnmatch);
    assertDeletionCatalogCoverage(await readDeletionCatalog(database));
  });
  it('creates only normalized original identities for new Matches', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database);
    const id = await createReportMatch(database, first, second);
    const [low, high] = [first, second].sort();
    expect(await anchor(id)).toEqual({ id, user_low_id: low, user_high_id: high });
  });
  it('rejects reassignment, retained-reference deletion and synthetic orphan identities', async () => {
    await expect(
      sql`UPDATE matching.match_reference_anchors SET user_high_id=${randomUUID()}::uuid WHERE id=${matchId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM matching.match_reference_anchors WHERE id=${matchId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    const [low, high] = [await createReportUser(database), await createReportUser(database)].sort();
    await expect(
      sql`INSERT INTO matching.match_reference_anchors VALUES(${randomUUID()}::uuid,${low}::uuid,${high}::uuid)`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.deleteFrom('matching.matches').where('id', '=', matchId).execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rolls back source creation if the mandatory reference insert is suppressed', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database);
    await sql`CREATE FUNCTION matching.m8_suppress_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER a_m8_suppress_reference BEFORE INSERT ON matching.match_reference_anchors FOR EACH ROW EXECUTE FUNCTION matching.m8_suppress_reference()`.execute(
      database,
    );
    try {
      await expect(createReportMatch(database, first, second)).rejects.toMatchObject({
        code: '23514',
      });
      expect(
        await database
          .selectFrom('matching.matches')
          .select('id')
          .where('user_low_id', '=', [first, second].sort()[0]!)
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER a_m8_suppress_reference ON matching.match_reference_anchors`.execute(
        database,
      );
      await sql`DROP FUNCTION matching.m8_suppress_reference()`.execute(database);
    }
  });
  it('preserves survivor report authority and denies outsiders and the deleted participant', async () => {
    const source = { kind: 'unmatched' as const, referenceId: matchId };
    expect(await resolveUnmatchedReportSource(database, survivor, source)).toMatchObject({
      targetUserId: owner,
    });
    expect(await resolveUnmatchedReportSource(database, owner, source)).toBeUndefined();
    expect(
      await resolveUnmatchedReportSource(database, await createReportUser(database), source),
    ).toBeUndefined();
  });
});
