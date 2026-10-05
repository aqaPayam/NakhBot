import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations, verifyMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('PostgreSQL migration bootstrap and M7 upgrade', () => {
  it.each([
    45, 51, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
  ])('upgrades from migration %i and preserves legacy appeal identity', async (baseline) => {
    const name = `nakh_appeal_upgrade_${randomUUID().replaceAll('-', '')}`;
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${name}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const previousDirectory = await mkdtemp(join(tmpdir(), 'nakh-appeal-upgrade-'));
    const directory = resolve(process.cwd(), 'migrations');
    let target: pg.Pool | undefined;
    let created = false;
    const userId = randomUUID(),
      historyId = randomUUID(),
      appealId = randomUUID();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      for (const filename of await readdir(directory)) {
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(filename) && Number(filename.slice(0, 6)) <= baseline)
          await copyFile(join(directory, filename), join(previousDirectory, filename));
      }
      expect((await runMigrations(targetUrl.toString(), previousDirectory)).applied).toHaveLength(
        baseline,
      );
      target = new pg.Pool({ connectionString: targetUrl.toString() });
      if (baseline === 51) {
        await target.query(
          'INSERT INTO identity.users (id, last_activity_at, created_at, updated_at) VALUES ($1, now(), now(), now())',
          [userId],
        );
        await target.query(
          "INSERT INTO identity.accounts (user_id, state, state_reason, state_changed_at) VALUES ($1, 'banned', 'test_ban', now())",
          [userId],
        );
        await target.query(
          "INSERT INTO identity.account_state_history (id, user_id, previous_state, next_state, reason_code, actor_type, changed_at) SELECT $1, user_id, 'active', 'banned', 'test_ban', 'system', state_changed_at FROM identity.accounts WHERE user_id = $2",
          [historyId, userId],
        );
        await target.query(
          'INSERT INTO moderation.user_appeals (id, user_id, ban_state_history_id, message_text) VALUES ($1, $2, $3, $4)',
          [appealId, userId, historyId, 'Legacy restricted appeal'],
        );
      }
      expect((await runMigrations(targetUrl.toString(), directory)).applied).toHaveLength(
        78 - baseline,
      );
      await verifyMigrations(targetUrl.toString(), join(directory, 'verify'));
      expect((await runMigrations(targetUrl.toString(), directory)).applied).toEqual([]);
      if (baseline === 51) {
        const result = await target.query(
          'SELECT id, ban_state_history_id, status, version FROM moderation.user_appeals WHERE id = $1',
          [appealId],
        );
        expect(result.rows).toEqual([
          { id: appealId, ban_state_history_id: historyId, status: 'submitted', version: 1 },
        ]);
        await expect(
          target.query(
            'INSERT INTO moderation.user_appeals (id, user_id, ban_state_history_id, message_text) VALUES ($1, $2, $3, $4)',
            [randomUUID(), userId, historyId, 'Duplicate'],
          ),
        ).rejects.toThrow();
      }
    } finally {
      await target?.end();
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
        await rm(previousDirectory, { recursive: true, force: true });
      }
    }
  });
  it('serializes empty-database bootstrap, upgrades M1, verifies, and replays unchanged', async () => {
    // This suite needs CREATEDB on the disposable CI database server.
    const name = `nakh_migration_${randomUUID().replaceAll('-', '')}`;
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${name}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const previousDirectory = await mkdtemp(join(tmpdir(), 'nakh-m1-migrations-'));
    const directory = resolve(process.cwd(), 'migrations');
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      for (const filename of await readdir(directory)) {
        if (/^00000[1-9]_[a-z0-9_]+\.sql$/u.test(filename))
          await copyFile(join(directory, filename), join(previousDirectory, filename));
      }
      const bootstrap = await Promise.all([
        runMigrations(targetUrl.toString(), previousDirectory),
        runMigrations(targetUrl.toString(), previousDirectory),
      ]);
      expect(bootstrap.map((result) => result.applied.length).sort((a, b) => a - b)).toEqual([
        0, 9,
      ]);
      const upgrade = await runMigrations(targetUrl.toString(), directory);
      expect(upgrade.applied).toEqual([
        '000010_m2_media_assets.sql',
        '000011_m2_profile_photos.sql',
        '000012_m2_media_quarantine.sql',
        '000013_m2_media_jobs.sql',
        '000014_m2_media_validation.sql',
        '000015_m2_media_cleanup.sql',
        '000016_m2_localization.sql',
        '000017_m3_discovery.sql',
        '000018_m3_interactions.sql',
        '000019_m3_matching.sql',
        '000020_m3_candidate_query.sql',
        '000021_m3_localization.sql',
        '000022_m3_telegram_delivery.sql',
        '000023_m3_telegram_delivery_receipts.sql',
        '000024_m3_telegram_receipt_key.sql',
        '000025_m4_credit_ledger.sql',
        '000026_m4_payment_intents.sql',
        '000027_m4_provider_receipts.sql',
        '000028_m4_feature_unlocks.sql',
        '000029_m4_notifications_refunds.sql',
        '000030_m4_localization.sql',
        '000031_m5_nakh_flows.sql',
        '000032_m5_pending_nakhes.sql',
        '000033_m5_delivered_nakhes.sql',
        '000034_m5_billing_matching.sql',
        '000035_m5_localization.sql',
        '000036_m5_reconciliation.sql',
        '000037_m5_query_plans.sql',
        '000038_m5_flow_lookup.sql',
        '000039_m5_ordered_flow_lookup.sql',
        '000040_m6_chat_catalog_messages.sql',
        '000041_m6_unmatch.sql',
        '000042_m6_notification_delivery.sql',
        '000043_m6_chat_retention.sql',
        '000044_m6_localization.sql',
        '000045_m6_reconciliation.sql',
        '000046_m7_reports.sql',
        '000047_m7_report_evidence.sql',
        '000048_m7_threshold_reviews_actions.sql',
        '000049_m7_review_consistency_fix.sql',
        '000050_m7_administration.sql',
        '000051_m7_support_appeals.sql',
        '000052_m7_appeal_admission.sql',
        '000053_m7_appeal_unban.sql',
        '000054_m7_localization.sql',
        '000055_m7_review_decisions.sql',
        '000056_m7_action_report_scope.sql',
        '000057_m7_evidence_access_identity.sql',
        '000058_m7_unmatch_report_deadline.sql',
        '000059_m7_photo_evidence_holds.sql',
        '000060_m7_photo_evidence_cleanup.sql',
        '000061_m7_photo_capture_complete.sql',
        '000062_m7_reconciliation.sql',
        '000063_m7_operational_indexes.sql',
        '000064_m7_admin_queue_localization.sql',
        '000065_m7_admin_support_mutation_localization.sql',
        '000066_m7_admin_appeal_review_localization.sql',
        '000067_m7_admin_appeal_unban_localization.sql',
        '000068_m7_admin_report_assignment_localization.sql',
        '000069_m7_admin_report_decision_localization.sql',
        '000070_m7_admin_report_account_localization.sql',
        '000071_m7_admin_report_evidence_localization.sql',
        '000072_m7_admin_report_photo_localization.sql',
        '000073_m7_admin_evidence_read_localization.sql',
        '000074_m7_report_internal_block_scope.sql',
        '000075_m7_admin_report_block_localization.sql',
        '000076_m7_integrity_history_index.sql',
        '000077_m7_admin_sessions.sql',
        '000078_m7_episode_resolution_index.sql',
      ]);
      expect(upgrade.existing).toHaveLength(9);
      const verified = await verifyMigrations(targetUrl.toString(), join(directory, 'verify'));
      expect(verified).toContain('000010_m2_media_assets.sql');
      expect(verified).toContain('000011_m2_profile_photos.sql');
      expect(verified).toContain('000012_m2_media_quarantine.sql');
      expect(verified).toContain('000013_m2_media_jobs.sql');
      expect(verified).toContain('000014_m2_media_validation.sql');
      expect(verified).toContain('000015_m2_media_cleanup.sql');
      expect(verified).toContain('000016_m2_localization.sql');
      expect(verified).toContain('000017_m3_discovery.sql');
      expect(verified).toContain('000018_m3_interactions.sql');
      expect(verified).toContain('000019_m3_matching.sql');
      expect(verified).toContain('000020_m3_candidate_query.sql');
      expect(verified).toContain('000021_m3_localization.sql');
      expect(verified).toContain('000022_m3_telegram_delivery.sql');
      expect(verified).toContain('000023_m3_telegram_delivery_receipts.sql');
      expect(verified).toContain('000024_m3_telegram_receipt_key.sql');
      expect(verified).toContain('000025_m4_credit_ledger.sql');
      expect(verified).toContain('000026_m4_payment_intents.sql');
      expect(verified).toContain('000027_m4_provider_receipts.sql');
      expect(verified).toContain('000028_m4_feature_unlocks.sql');
      expect(verified).toContain('000029_m4_notifications_refunds.sql');
      expect(verified).toContain('000030_m4_localization.sql');
      expect(verified).toContain('000031_m5_nakh_flows.sql');
      expect(verified).toContain('000032_m5_pending_nakhes.sql');
      expect(verified).toContain('000033_m5_delivered_nakhes.sql');
      expect(verified).toContain('000034_m5_billing_matching.sql');
      expect(verified).toContain('000035_m5_localization.sql');
      expect(verified).toContain('000036_m5_reconciliation.sql');
      expect(verified).toContain('000037_m5_query_plans.sql');
      expect(verified).toContain('000038_m5_flow_lookup.sql');
      expect(verified).toContain('000039_m5_ordered_flow_lookup.sql');
      expect(verified).toContain('000040_m6_chat_catalog_messages.sql');
      expect(verified).toContain('000041_m6_unmatch.sql');
      expect(verified).toContain('000042_m6_notification_delivery.sql');
      expect(verified).toContain('000043_m6_chat_retention.sql');
      expect(verified).toContain('000044_m6_localization.sql');
      expect(verified).toContain('000045_m6_reconciliation.sql');
      expect(verified).toContain('000046_m7_reports.sql');
      expect(verified).toContain('000047_m7_report_evidence.sql');
      expect(verified).toContain('000048_m7_threshold_reviews_actions.sql');
      expect(verified).toContain('000049_m7_review_consistency_fix.sql');
      expect(verified).toContain('000050_m7_administration.sql');
      expect(verified).toContain('000051_m7_support_appeals.sql');
      expect(verified).toContain('000052_m7_appeal_admission.sql');
      expect(verified).toContain('000053_m7_appeal_unban.sql');
      expect(verified).toContain('000054_m7_localization.sql');
      expect(verified).toContain('000055_m7_review_decisions.sql');
      expect(verified).toContain('000056_m7_action_report_scope.sql');
      expect(verified).toContain('000057_m7_evidence_access_identity.sql');
      expect(verified).toContain('000058_m7_unmatch_report_deadline.sql');
      expect(verified).toContain('000059_m7_photo_evidence_holds.sql');
      expect(verified).toContain('000060_m7_photo_evidence_cleanup.sql');
      expect(verified).toContain('000061_m7_photo_capture_complete.sql');
      expect(verified).toContain('000062_m7_reconciliation.sql');
      expect(verified).toContain('000063_m7_operational_indexes.sql');
      expect(verified).toContain('000064_m7_admin_queue_localization.sql');
      expect(verified).toContain('000065_m7_admin_support_mutation_localization.sql');
      expect(verified).toContain('000066_m7_admin_appeal_review_localization.sql');
      expect(verified).toContain('000067_m7_admin_appeal_unban_localization.sql');
      expect(verified).toContain('000068_m7_admin_report_assignment_localization.sql');
      expect(verified).toContain('000069_m7_admin_report_decision_localization.sql');
      expect(verified).toContain('000070_m7_admin_report_account_localization.sql');
      expect(verified).toContain('000071_m7_admin_report_evidence_localization.sql');
      expect(verified).toContain('000072_m7_admin_report_photo_localization.sql');
      expect(verified).toContain('000073_m7_admin_evidence_read_localization.sql');
      expect(verified).toContain('000074_m7_report_internal_block_scope.sql');
      expect(verified).toContain('000075_m7_admin_report_block_localization.sql');
      expect(verified).toContain('000076_m7_integrity_history_index.sql');
      expect(verified).toContain('000077_m7_admin_sessions.sql');
      expect(verified).toContain('000078_m7_episode_resolution_index.sql');
      const replay = await runMigrations(targetUrl.toString(), directory);
      expect(replay.applied).toEqual([]);
      expect(replay.existing).toHaveLength(78);
    } finally {
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
        await rm(previousDirectory, { recursive: true, force: true });
      }
    }
  });
});
