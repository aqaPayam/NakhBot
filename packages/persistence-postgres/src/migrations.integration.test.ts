import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations, verifyMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('PostgreSQL migration bootstrap and M4 upgrade', () => {
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
      const replay = await runMigrations(targetUrl.toString(), directory);
      expect(replay.applied).toEqual([]);
      expect(replay.existing).toHaveLength(30);
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
