import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createReportUser } from './testing/report-fixture.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresNotificationStore } from './notification-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 populated original notification-life upgrade', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let userId: string, notificationId: string, deliveryId: string;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_notice_lives');
    const directory = await mkdtemp(join(tmpdir(), 'm8-notice108-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 108)
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
    userId = await createReportUser(database, true);
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: new Date(), updated_at: new Date() })
      .execute();
    const cause = randomUUID();
    // Historical producer omits the not-yet-existing epoch, as migration 108 did.
    const recorded = await new PostgresNotificationStore(database).record({
      userId,
      type: 'safety_notice',
      titleKey: 'notification.safety_notice.title',
      bodyKey: 'notification.safety_notice.body',
      payload: { cause },
      deduplicationKey: `legacy-notice:${cause}`,
      correlationId: cause,
      causationId: cause,
    });
    notificationId = recorded.notificationId;
    deliveryId = recorded.telegramDeliveryId!;
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });

  it('rejects ambiguous legacy ownership, rolls back, and upgrades exactly once across twenty connections', async () => {
    const snapshot = async (): Promise<unknown[]> =>
      Promise.all([
        sql`SELECT id,user_id,notification_type,category,title_key,body_key,payload,payload_schema_version,status,deduplication_key,created_at::text,read_at::text,version FROM notification.notifications WHERE id=${notificationId}::uuid`
          .execute(database)
          .then((result) => result.rows),
        database
          .selectFrom('notification.notification_deliveries')
          .selectAll()
          .where('id', '=', deliveryId)
          .execute(),
        database
          .selectFrom('platform.outbox_events')
          .selectAll()
          .where('aggregate_id', '=', deliveryId)
          .execute()
          .then((rows) =>
            rows.map((row) => Object.assign({ deletion_cancellation_audit_id: null }, row)),
          ),
        database
          .selectFrom('billing.credit_transactions')
          .selectAll()
          .where('user_id', '=', userId)
          .execute(),
      ]);
    const original = await snapshot();
    const setEpoch = async (epoch: number): Promise<void> => {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE identity.accounts SET product_epoch=${epoch} WHERE user_id=${userId}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    };
    // Deliberate negative corruption only, not a genuine return.
    await setEpoch(1);
    try {
      await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toThrow(
        'legacy notification lacks its original recipient life',
      );
      expect(
        (
          await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='notification' AND table_name='notifications' AND column_name='product_epoch'`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      expect(await snapshot()).toEqual(original);
    } finally {
      await setEpoch(0);
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(results.flatMap((result) => result.applied)).toEqual([
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
      '000148_m8_protected_profile_change_lives.sql',
      '000149_m8_live_retained_safety_holds.sql',
      '000150_m8_batched_photo_sources.sql',
      '000151_m8_minimal_review_response_receipts.sql',
      '000152_m9_signup_presentation.sql',
      '000153_m9_candidate_media_authority.sql',
      '000154_m9_preview_consumption_disposition.sql',
    ]);
    expect(await snapshot()).toEqual(original);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('product_epoch')
        .where('id', '=', notificationId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ product_epoch: 0 });
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000109_m8_notification_original_lives.sql',
    );
    assertDeletionCatalogCoverage(await readDeletionCatalog(database));
  });
});
