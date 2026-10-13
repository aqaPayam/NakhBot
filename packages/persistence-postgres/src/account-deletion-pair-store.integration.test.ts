import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportChat,
  createReportUnmatch,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionReferencedLikeStore } from './account-deletion-referenced-like-store.js';
import { PostgresAccountDeletionPairStore } from './account-deletion-pair-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Scene = Readonly<{
  lease: AccountDeletionLease;
  other: string;
  matchId: string;
  blockedOther: string;
}>;
describe.skipIf(url === undefined)('M8 original pair removal and Match lifetimes', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionPairStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_pair_archive');
    const temporaryRoot = resolve(tmpdir()),
      directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-pair120-')));
    if (!directory.startsWith(`${temporaryRoot}${sep}`))
      throw Error('Unsafe migration temporary path');
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 120)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    const first = await createReportUser(database, true),
      second = await createReportUser(database, true);
    const legacy = await createReportUnmatch(
      database,
      first,
      second,
      new Date(Date.now() - 172800000),
    );
    const original =
      await sql`SELECT jsonb_build_object('match',(SELECT to_jsonb(r) FROM matching.matches r WHERE id=${legacy.matchId}::uuid),
      'unmatch',(SELECT to_jsonb(r) FROM matching.unmatch_records r WHERE match_id=${legacy.matchId}::uuid),
      'pair',(SELECT to_jsonb(r) FROM interaction.user_pair_states r WHERE ${first}::uuid IN(user_low_id,user_high_id))) AS facts`.execute(
        database,
      );
    const migrations = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(migrations.flatMap((r) => r.applied)).toEqual([
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
    ]);
    expect(
      (
        await sql`SELECT jsonb_build_object('match',(SELECT to_jsonb(r) FROM matching.matches r WHERE id=${legacy.matchId}::uuid),
      'unmatch',(SELECT to_jsonb(r) FROM matching.unmatch_records r WHERE match_id=${legacy.matchId}::uuid),
      'pair',(SELECT to_jsonb(r) FROM interaction.user_pair_states r WHERE ${first}::uuid IN(user_low_id,user_high_id))) AS facts`.execute(
          database,
        )
      ).rows,
    ).toEqual(original.rows);
    expect(
      (
        await sql`SELECT low_product_epoch,high_product_epoch FROM matching.match_reference_anchors WHERE id=${legacy.matchId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ low_product_epoch: 0, high_product_epoch: 0 }]);
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionPairStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
      database,
    );
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const claims = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(claims).toHaveLength(1);
    return claims[0]!;
  }
  async function scene(unmatched = false, clean = true): Promise<Scene> {
    const other = await createReportUser(database, true),
      blockedOther = await createReportUser(database, true);
    let matchId = '';
    const item = await createDeletionFixture(database, async (owner) => {
      await sql`INSERT INTO notification.notification_preferences(user_id,created_at,updated_at)
        SELECT user_id,clock_timestamp(),clock_timestamp() FROM identity.accounts WHERE user_id IN(${owner}::uuid,${other}::uuid)
        ON CONFLICT(user_id) DO NOTHING`.execute(database);
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${owner}::uuid`.execute(
        database,
      );
      if (unmatched)
        matchId = (
          await createReportUnmatch(database, owner, other, new Date(Date.now() - 172800000))
        ).matchId;
      else {
        matchId = (await createReportChat(database, owner, other)).matchId;
        const [low, high] = [owner, other].sort();
        await sql`INSERT INTO interaction.user_pair_states(user_low_id,user_high_id,state,reason_code,changed_at)
          VALUES(${low}::uuid,${high}::uuid,'matched','match',clock_timestamp())`.execute(database);
      }
      const [low, high] = [owner, blockedOther].sort();
      await sql`INSERT INTO interaction.user_pair_states(user_low_id,user_high_id,state,reason_code,changed_at)
        VALUES(${low}::uuid,${high}::uuid,'blocked','admin_internal_block',clock_timestamp())`.execute(
        database,
      );
    });
    const checkpoint = new PostgresAccountDeletionCheckpointStore(database),
      shared = await claim();
    while ((await new PostgresAccountDeletionSharedStore(database).closeNext(shared)).hasMore) {
      /* Resume bounded original-source batches. */
    }
    await checkpoint.finishShared(shared);
    const evidence = await claim();
    while ((await new PostgresAccountDeletionChatStore(database).archiveNext(evidence)).hasMore) {
      /* Resume bounded original-source batches. */
    }
    while ((await new PostgresAccountDeletionMatchStore(database).archiveNext(evidence)).hasMore) {
      /* Resume bounded original-source batches. */
    }
    await new PostgresAccountDeletionProfileStore(database).archive(evidence);
    await checkpoint.finishEvidence(evidence);
    const lease = await claim();
    expect(lease.deletionRecordId).toBe(item.recordId);
    if (clean)
      while (
        (await new PostgresAccountDeletionReferencedLikeStore(database).purgeNext(lease)).hasMore
      ) {
        /* Resume bounded original-source batches. */
      }
    return { lease, other, matchId, blockedOther };
  }
  async function facts(item: Scene): Promise<unknown> {
    return (
      await sql`SELECT jsonb_build_object(
    'account',(SELECT to_jsonb(r) FROM identity.accounts r WHERE user_id=${item.lease.userId}::uuid),
    'root',(SELECT to_jsonb(r) FROM identity.account_deletion_records r WHERE id=${item.lease.deletionRecordId}::uuid),
    'preview',(SELECT to_jsonb(r) FROM identity.guest_preview_counters r WHERE user_id=${item.lease.userId}::uuid),
    'match',(SELECT to_jsonb(r) FROM matching.match_reference_anchors r WHERE id=${item.matchId}::uuid),
    'unmatch',(SELECT to_jsonb(r) FROM matching.unmatch_records r WHERE match_id=${item.matchId}::uuid),
    'blocked',(SELECT to_jsonb(r) FROM interaction.user_pair_states r WHERE ${item.blockedOther}::uuid IN(user_low_id,user_high_id))) AS facts`.execute(
        database,
      )
    ).rows;
  }
  it.each([false, true])(
    'removes an original closed pair once under twenty retries, Unmatch=%s',
    async (unmatched) => {
      const item = await scene(unmatched),
        before = await facts(item);
      const result = await Promise.all(
        Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
      );
      expect(result.reduce((n, r) => n + r.purgedRows, 0)).toBe(1);
      expect(result.every((r) => !r.hasMore && !r.waitingForSources)).toBe(true);
      expect(await facts(item)).toEqual(before);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_pair_receipts WHERE match_id=${item.matchId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(await store.purgeNext(item.lease)).toEqual({
        purgedRows: 0,
        hasMore: false,
        waitingForSources: false,
      });
      await expect(
        sql`DELETE FROM identity.account_deletion_pair_receipts WHERE match_id=${item.matchId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    },
  );
  it('waits for original Likes without inventing absence and resumes after their verified removal', async () => {
    const item = await scene(false, false);
    expect(await store.purgeNext(item.lease)).toEqual({
      purgedRows: 0,
      hasMore: true,
      waitingForSources: true,
    });
    while (
      (await new PostgresAccountDeletionReferencedLikeStore(database).purgeNext(item.lease)).hasMore
    ) {
      /* Resume bounded original-source batches. */
    }
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
  });
  it.each(['receipt', 'audit', 'event', 'pair'] as const)(
    'rolls back a suppressed required %s and retries exactly once',
    async (kind) => {
      const item = await scene(),
        before = await facts(item),
        table = {
          receipt: 'identity.account_deletion_pair_receipts',
          audit: 'platform.audit_logs',
          event: 'platform.outbox_events',
          pair: 'interaction.user_pair_states',
        }[kind];
      await sql
        .raw(
          `CREATE FUNCTION identity.m8_pair_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER a_m8_pair_suppress BEFORE ${kind === 'pair' ? 'DELETE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_pair_suppress()`,
        )
        .execute(database);
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
        expect(await facts(item)).toEqual(before);
        expect(
          (
            await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_pair_receipts WHERE match_id=${item.matchId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await sql.raw(`DROP TRIGGER a_m8_pair_suppress ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_pair_suppress()`.execute(database);
      }
      expect(await store.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
    },
  );
  it('rejects direct ordinary deletion and borrowed lease authority without changing facts', async () => {
    const item = await scene(),
      before = await facts(item);
    await expect(
      sql`DELETE FROM interaction.user_pair_states WHERE ${item.other}::uuid IN(user_low_id,user_high_id)`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    for (const lease of [
      { ...item.lease, userId: item.other },
      { ...item.lease, leaseOwner: randomUUID() },
      { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
      { ...item.lease, deletionRecordId: randomUUID() },
    ])
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ status: 409 });
    expect(await facts(item)).toEqual(before);
  });
  it('denies empty replay after physically losing the removal receipt, using the original Match witness', async () => {
    const item = await scene();
    await store.purgeNext(item.lease);
    expect(
      (
        await sql`SELECT identity.deletion_pair_proofs_valid(${item.lease.deletionRecordId}::uuid,${item.lease.userId}::uuid) AS valid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
    const before = await facts(item);
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`DELETE FROM identity.account_deletion_pair_receipts WHERE match_id=${item.matchId}::uuid`.execute(
        tx,
      );
    });
    expect(
      (
        await sql`SELECT identity.deletion_pair_proofs_valid(${item.lease.deletionRecordId}::uuid,${item.lease.userId}::uuid) AS valid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: false }]);
    await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
    expect(await facts(item)).toEqual(before);
  });
  it('binds the receipt digest to both original Match lives and denies corrupted historical proof', async () => {
    const item = await scene();
    await store.purgeNext(item.lease);
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE matching.match_reference_anchors SET low_product_epoch=low_product_epoch+1 WHERE id=${item.matchId}::uuid`.execute(
        tx,
      );
    });
    await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE matching.match_reference_anchors SET low_product_epoch=low_product_epoch-1 WHERE id=${item.matchId}::uuid`.execute(
        tx,
      );
    });
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedRows: 0, hasMore: false });
  });
  it('allows a distinct later Match life while denying retired identity reuse and preserving old Unmatch proof', async () => {
    const item = await scene(true);
    await store.purgeNext(item.lease);
    const originalUnmatch = (
      await sql`SELECT to_jsonb(r) AS facts FROM matching.unmatch_records r WHERE match_id=${item.matchId}::uuid`.execute(
        database,
      )
    ).rows;
    // Physical repair fixtures model a later life only; production return remains denied.
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE identity.accounts SET state='active',product_epoch=1,version=version+1 WHERE user_id=${item.lease.userId}::uuid`.execute(
        tx,
      );
    });
    const id = randomUUID(),
      firstLike = randomUUID(),
      secondLike = randomUUID();
    const [low, high] = [item.lease.userId, item.other].sort();
    await database.transaction().execute(async (tx) => {
      await sql`INSERT INTO interaction.likes(id,sender_user_id,receiver_user_id,status,created_at,sender_product_epoch,receiver_product_epoch)
        VALUES(${firstLike}::uuid,${item.lease.userId}::uuid,${item.other}::uuid,'active',clock_timestamp(),1,0),
          (${secondLike}::uuid,${item.other}::uuid,${item.lease.userId}::uuid,'active',clock_timestamp(),0,1)`.execute(
        tx,
      );
      await sql`INSERT INTO matching.matches(id,user_low_id,user_high_id,source,source_like_a_id,source_like_b_id,status,created_at)
        VALUES(${id}::uuid,${low}::uuid,${high}::uuid,'mutual_like',${firstLike}::uuid,${secondLike}::uuid,'active',clock_timestamp())`.execute(
        tx,
      );
      await sql`INSERT INTO matching.match_participants(match_id,user_id,joined_at)
        VALUES(${id}::uuid,${low}::uuid,clock_timestamp()),(${id}::uuid,${high}::uuid,clock_timestamp())`.execute(
        tx,
      );
    });
    expect(
      (
        await sql`SELECT low_product_epoch,high_product_epoch FROM matching.match_reference_anchors WHERE id=${id}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      {
        low_product_epoch: low === item.lease.userId ? 1 : 0,
        high_product_epoch: low === item.lease.userId ? 0 : 1,
      },
    ]);
    await expect(
      sql`UPDATE matching.match_reference_anchors SET low_product_epoch=2 WHERE id=${id}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`INSERT INTO matching.matches SELECT ${item.matchId}::uuid,user_low_id,user_high_id,source,source_like_a_id,source_like_b_id,source_nakh_id,status,created_at,closed_at,version FROM matching.matches WHERE id=${id}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await sql`SELECT to_jsonb(r) AS facts FROM matching.unmatch_records r WHERE match_id=${item.matchId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(originalUnmatch);
  });
  it('rolls back commit-time lease expiry and resumes under a new generation', async () => {
    const item = await scene();
    await work.release(item.lease);
    const lease = await claim(2000),
      before = await facts(item);
    await sql`CREATE FUNCTION identity.m8_pair_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.1); RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER a_m8_pair_pause AFTER INSERT ON identity.account_deletion_pair_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.m8_pair_pause()`.execute(
      database,
    );
    try {
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ status: 409 });
      expect(await facts(item)).toEqual(before);
    } finally {
      await sql`DROP TRIGGER a_m8_pair_pause ON identity.account_deletion_pair_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.m8_pair_pause()`.execute(database);
    }
    const next = await claim();
    expect(next.leaseGeneration).toBeGreaterThan(lease.leaseGeneration);
    expect(await store.purgeNext(next)).toMatchObject({ purgedRows: 1, hasMore: false });
  });
});
