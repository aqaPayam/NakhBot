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
    const fixture = await createDeletionFixture(
      database,
      async (userId) => {
        await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${userId}::uuid`.execute(
          database,
        );
        matchId = (await createReportUnmatch(database, survivor, userId)).matchId;
      },
      'pre_epoch',
    );
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
      '000094_m8_photo_archival.sql',
      '000095_m8_evidence_checkpoint.sql',
      '000096_m8_product_batches.sql',
      '000097_m8_payment_lifecycle.sql',
      '000098_m8_media_delivery_authority.sql',
      '000099_m8_credit_lifecycle_provenance.sql',
      '000100_m8_deletion_lifecycle_binding.sql',
      '000101_m8_credit_epoch_partition.sql',
      '000102_m8_support_epoch_closure.sql',
      '000103_m8_support_closure_proof_view.sql',
      '000104_m8_like_original_lives.sql',
      '000105_m8_nakh_original_lives.sql',
      '000106_m8_nakh_references.sql',
      '000107_m8_nakh_funding_lives.sql',
      '000108_m8_unreferenced_like_purge.sql',
      '000109_m8_notification_original_lives.sql',
      '000110_m8_nakh_retained_links.sql',
      '000111_m8_funded_nakh_archival.sql',
      '000112_m8_pending_nakh_references.sql',
      '000113_m8_pending_funding_binding.sql',
      '000114_m8_paid_pending_archival.sql',
      '000115_m8_terminal_pending_archival.sql',
      '000116_m8_flow_references.sql',
      '000117_m8_flow_archival.sql',
      '000118_m8_referenced_like_archival.sql',
      '000119_m8_unlock_original_references.sql',
      '000120_m8_owned_unlock_archival.sql',
      '000121_m8_match_original_lives.sql',
      '000122_m8_pair_archival.sql',
      '000123_m8_notification_references.sql',
      '000124_m8_notification_archival.sql',
      '000125_m8_owned_transport_batches.sql',
      '000126_m8_operational_outbox_cancellation.sql',
      '000127_m8_product_checkpoint.sql',
      '000128_m8_product_fence_lock_order.sql',
      '000129_m8_account_media_provider_work.sql',
      '000130_m8_media_checkpoint.sql',
      '000131_m8_private_photo_parallel_read.sql',
      '000132_m8_sample_source_cleanup.sql',
      '000133_m8_liked_by_request_life.sql',
      '000134_m7_account_action_proof_index.sql',
      '000135_m8_deletion_sessions.sql',
      '000136_m8_ephemeral_checkpoint.sql',
      '000137_m8_retention_manifest.sql',
      '000138_m8_final_verification.sql',
      '000139_m8_account_control.sql',
      '000140_m8_deletion_localization.sql',
      '000141_m8_return_approval.sql',
      '000142_m8_fresh_account_return.sql',
      '000143_m8_return_localization.sql',
      '000144_m8_fresh_entry_localization.sql',
      '000145_m8_retention_policy.sql',
      '000146_m8_retained_source_membership.sql',
      '000147_m8_support_content_release.sql',
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
    expect(await anchor(matchId)).toEqual({
      id: matchId,
      user_low_id: low,
      user_high_id: high,
      low_product_epoch: 0,
      high_product_epoch: 0,
    });
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
    expect(await anchor(id)).toEqual({
      id,
      user_low_id: low,
      user_high_id: high,
      low_product_epoch: 0,
      high_product_epoch: 0,
    });
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
      sql`INSERT INTO matching.match_reference_anchors(id,user_low_id,user_high_id) VALUES(${randomUUID()}::uuid,${low}::uuid,${high}::uuid)`.execute(
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
