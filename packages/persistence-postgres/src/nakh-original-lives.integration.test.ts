import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createReportUser } from './testing/report-fixture.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 populated original Nakh-life upgrade', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let sender: string, receiver: string, flowId: string, pendingId: string, intentId: string;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_nakh_lives');
    const directory = await mkdtemp(join(tmpdir(), 'm8-nakh104-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 104)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
    sender = await createReportUser(database, true);
    receiver = await createReportUser(database, true);
    flowId = randomUUID();
    pendingId = randomUUID();
    intentId = randomUUID();
    const at = new Date(),
      expires = new Date(at.getTime() + 14 * 86400000);
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto('nakh.nakh_flows')
        .values({ id: flowId, sender_user_id: sender, receiver_user_id: receiver, created_at: at })
        .execute();
      await tx
        .insertInto('billing.pending_payments')
        .values({
          id: intentId,
          user_id: sender,
          reason: 'send_nakh',
          target_type: 'pending_nakh',
          target_id: pendingId,
          funding_type: 'telegram_stars',
          required_credits: null,
          required_stars: '2',
          package_code_snapshot: null,
          package_credit_amount_snapshot: null,
          idempotency_key: `m8-nakh-intent:${intentId}`,
          request_hash: 'a'.repeat(64),
          created_at: at,
          expires_at: expires,
          resolved_at: null,
        })
        .execute();
      await tx
        .insertInto('nakh.pending_nakhes')
        .values({
          id: pendingId,
          nakh_flow_id: flowId,
          sender_user_id: sender,
          text: 'Original private pending text',
          pending_payment_id: intentId,
          auto_settle_authorized_at: at,
          authorization_source: 'explore',
          authorized_at: at,
          created_at: at,
          expires_at: expires,
          paid_at: null,
          cancelled_at: null,
          expired_at: null,
          closed_at: null,
          cancel_resolution: null,
          last_reminder_at: null,
          idempotency_key: `m8-nakh-pending:${pendingId}`,
          request_hash: 'b'.repeat(64),
        })
        .execute();
      await tx
        .updateTable('platform.user_counters')
        .set({ pending_nakh_count: 1, version: 2, updated_at: at })
        .where('user_id', '=', sender)
        .execute();
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  it('rejects ambiguous legacy ownership, then upgrades exactly once across twenty connections without changing source, text, funding or counter facts', async () => {
    const snapshot = async (): Promise<readonly unknown[]> =>
      Promise.all([
        sql`SELECT id,sender_user_id,receiver_user_id,created_at::text FROM nakh.nakh_flows WHERE id=${flowId}::uuid`
          .execute(database)
          .then((result) => result.rows),
        database
          .selectFrom('nakh.pending_nakhes')
          .selectAll()
          .where('id', '=', pendingId)
          .execute(),
        database
          .selectFrom('billing.pending_payments')
          .selectAll()
          .where('id', '=', intentId)
          .execute(),
        database
          .selectFrom('platform.user_counters')
          .selectAll()
          .where('user_id', '=', sender)
          .execute(),
      ]);
    const original = await snapshot();
    // Negative legacy-corruption probe only, never successful fresh-return evidence.
    const setEpoch = async (value: number): Promise<void> => {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE identity.accounts SET product_epoch=${value} WHERE user_id=${receiver}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    };
    await setEpoch(1);
    try {
      await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toThrow(
        'legacy Nakh flow lacks exact original lives',
      );
      expect(
        (
          await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='nakh' AND table_name='nakh_flows' AND column_name IN ('sender_product_epoch','receiver_product_epoch')`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      expect(await snapshot()).toEqual(original);
    } finally {
      await setEpoch(0);
    }
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(outcomes.flatMap((result) => result.applied)).toEqual([
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
    ]);
    expect(await snapshot()).toEqual(original);
    expect(
      await database
        .selectFrom('nakh.nakh_flows')
        .select(['sender_product_epoch', 'receiver_product_epoch'])
        .where('id', '=', flowId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ sender_product_epoch: 0, receiver_product_epoch: 0 });
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000105_m8_nakh_original_lives.sql',
    );
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    await expect(
      database
        .updateTable('nakh.nakh_flows')
        .set({ receiver_product_epoch: 1 })
        .where('id', '=', flowId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    assertDeletionCatalogCoverage(await readDeletionCatalog(database));
  });
  it('rolls back a pending source and quota at actual commit when original funding life is corrupted', async () => {
    const newFlow = randomUUID(),
      newPending = randomUUID(),
      newIntent = randomUUID();
    const originalCounter = await database
      .selectFrom('platform.user_counters')
      .selectAll()
      .where('user_id', '=', sender)
      .executeTakeFirstOrThrow();
    const at = new Date(),
      expires = new Date(at.getTime() + 14 * 86400000);
    const third = await createReportUser(database, true);
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .insertInto('nakh.nakh_flows')
          .values({ id: newFlow, sender_user_id: sender, receiver_user_id: third, created_at: at })
          .execute();
        await tx
          .insertInto('billing.pending_payments')
          .values({
            id: newIntent,
            user_id: sender,
            reason: 'send_nakh',
            target_type: 'pending_nakh',
            target_id: newPending,
            funding_type: 'telegram_stars',
            required_credits: null,
            required_stars: '2',
            package_code_snapshot: null,
            package_credit_amount_snapshot: null,
            idempotency_key: `m8-nakh-forged:${newIntent}`,
            request_hash: 'c'.repeat(64),
            created_at: at,
            expires_at: expires,
            resolved_at: null,
          })
          .execute();
        // Negative corruption, transaction-local and rolled back: prove the new
        // deferred guard independently of the existing intent update guard.
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        await sql`UPDATE billing.pending_payments SET product_epoch=1 WHERE id=${newIntent}::uuid`.execute(
          tx,
        );
        await sql`SET LOCAL session_replication_role=origin`.execute(tx);
        await tx
          .insertInto('nakh.pending_nakhes')
          .values({
            id: newPending,
            nakh_flow_id: newFlow,
            sender_user_id: sender,
            text: 'Must never commit',
            pending_payment_id: newIntent,
            auto_settle_authorized_at: at,
            authorization_source: 'explore',
            authorized_at: at,
            created_at: at,
            expires_at: expires,
            paid_at: null,
            cancelled_at: null,
            expired_at: null,
            closed_at: null,
            cancel_resolution: null,
            last_reminder_at: null,
            idempotency_key: `m8-nakh-forged:${newPending}`,
            request_hash: 'd'.repeat(64),
          })
          .execute();
        await tx
          .updateTable('platform.user_counters')
          .set({
            pending_nakh_count: originalCounter.pending_nakh_count + 1,
            version: originalCounter.version + 1,
            updated_at: at,
          })
          .where('user_id', '=', sender)
          .execute();
      }),
    ).rejects.toMatchObject({
      code: '23514',
      where: expect.stringContaining('verify_pending_nakh_payment()') as unknown,
    });
    expect(
      await database.selectFrom('nakh.nakh_flows').select('id').where('id', '=', newFlow).execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('nakh.pending_nakhes')
        .select('id')
        .where('id', '=', newPending)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('billing.pending_payments')
        .select('id')
        .where('id', '=', newIntent)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('platform.user_counters')
        .selectAll()
        .where('user_id', '=', sender)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalCounter);
  });

  it('waits behind an actual committing tombstone and refuses native late flow admission', async () => {
    await sql`CREATE FUNCTION identity.m8_nakh_hold_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state='deleted' AND OLD.state<>'deleted' THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_nakh_hold_tombstone AFTER UPDATE ON identity.accounts FOR EACH ROW EXECUTE FUNCTION identity.m8_nakh_hold_tombstone()`.execute(
      database,
    );
    let owner: string | undefined;
    let deletion: ReturnType<typeof createDeletionFixture> | undefined;
    try {
      deletion = createDeletionFixture(database, (id) => {
        owner = id;
        return Promise.resolve();
      });
      let sleeping = false;
      for (let attempt = 0; attempt < 200 && !sleeping; attempt++) {
        sleeping =
          owner !== undefined &&
          (
            await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event='PgSleep') AS waiting`.execute(database)
          ).rows[0]!.waiting;
        if (!sleeping) await delay(20);
      }
      expect(sleeping).toBe(true);
      const id = randomUUID();
      const insertion = database
        .insertInto('nakh.nakh_flows')
        .values({ id, sender_user_id: receiver, receiver_user_id: owner!, created_at: new Date() })
        .execute();
      const [removed, inserted] = await Promise.allSettled([deletion, insertion]);
      expect(removed.status).toBe('fulfilled');
      expect(inserted).toMatchObject({ status: 'rejected', reason: { code: '40001' } });
      expect(
        await database.selectFrom('nakh.nakh_flows').select('id').where('id', '=', id).execute(),
      ).toEqual([]);
    } finally {
      await deletion?.catch(() => undefined);
      await sql`DROP TRIGGER m8_nakh_hold_tombstone ON identity.accounts`.execute(database);
      await sql`DROP FUNCTION identity.m8_nakh_hold_tombstone()`.execute(database);
    }
  });
});
