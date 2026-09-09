import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations, verifyMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('PostgreSQL migration bootstrap and M2 upgrade', () => {
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
      ]);
      expect(upgrade.existing).toHaveLength(9);
      const verified = await verifyMigrations(targetUrl.toString(), join(directory, 'verify'));
      expect(verified).toContain('000010_m2_media_assets.sql');
      expect(verified).toContain('000011_m2_profile_photos.sql');
      expect(verified).toContain('000012_m2_media_quarantine.sql');
      expect(verified).toContain('000013_m2_media_jobs.sql');
      const replay = await runMigrations(targetUrl.toString(), directory);
      expect(replay.applied).toEqual([]);
      expect(replay.existing).toHaveLength(13);
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
