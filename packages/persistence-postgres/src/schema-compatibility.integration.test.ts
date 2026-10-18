import { mkdtemp, copyFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, sourceMigrationDigests, verifyMigrationLedger } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M9 selected image native schema admission', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_schema_admission');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 4,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 5000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  const verify = (): ReturnType<typeof verifyMigrationLedger> =>
    verifyMigrationLedger(isolated.url, resolve('migrations'));
  it('admits the exact current native source without modifying its ledger', async () => {
    const before = (
      await sql`SELECT name,sha256,applied_at FROM platform.schema_migrations ORDER BY name`.execute(
        database,
      )
    ).rows;
    const first = await verify(),
      second = await verify();
    expect(first).toEqual(second);
    expect(first.migrations).toBe(159);
    expect(first.ledgerDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (
        await sql`SELECT name,sha256,applied_at FROM platform.schema_migrations ORDER BY name`.execute(
          database,
        )
      ).rows,
    ).toEqual(before);
  });
  it('rejects a modified checksum instead of using a migration count as compatibility', async () => {
    const original = (await sourceMigrationDigests(resolve('migrations')))[0]!;
    await sql`UPDATE platform.schema_migrations SET sha256=${'0'.repeat(64)} WHERE name=${original.name}`.execute(
      database,
    );
    try {
      await expect(verify()).rejects.toThrow('Selected image schema is not compatible.');
    } finally {
      await sql`UPDATE platform.schema_migrations SET sha256=${original.sha256} WHERE name=${original.name}`.execute(
        database,
      );
    }
  });
  it('rejects missing and additional ledger entries, preserving forward-only migration history', async () => {
    const original = (await sourceMigrationDigests(resolve('migrations')))[0]!;
    await sql`DELETE FROM platform.schema_migrations WHERE name=${original.name}`.execute(database);
    try {
      await expect(verify()).rejects.toThrow('Selected image schema is not compatible.');
    } finally {
      await sql`INSERT INTO platform.schema_migrations(name,sha256) VALUES(${original.name},${original.sha256})`.execute(
        database,
      );
    }
    await sql`INSERT INTO platform.schema_migrations(name,sha256) VALUES('999999_future.sql',${'1'.repeat(64)})`.execute(
      database,
    );
    try {
      await expect(verify()).rejects.toThrow('Selected image schema is not compatible.');
    } finally {
      await sql`DELETE FROM platform.schema_migrations WHERE name='999999_future.sql'`.execute(
        database,
      );
    }
  });
  it('refuses an actual older image source inventory against the already newer database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nakh-old-image-'));
    const files = (await sourceMigrationDigests(resolve('migrations'))).slice(0, -1);
    try {
      for (const file of files)
        await copyFile(join(resolve('migrations'), file.name), join(directory, file.name));
      await expect(verifyMigrationLedger(isolated.url, directory)).rejects.toThrow(
        'Selected image schema is not compatible.',
      );
    } finally {
      for (const file of await readdir(directory)) await unlink(join(directory, file));
      await rmdir(directory);
    }
  });
  it('runs the compiled image command outside a Git checkout and sanitizes rejection output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nakh-schema-cli-'));
    const files = await sourceMigrationDigests(resolve('migrations'));
    const { mkdir } = await import('node:fs/promises');
    const migrationDirectory = join(directory, 'migrations');
    await mkdir(migrationDirectory);
    const cli = resolve('packages/persistence-postgres/dist/cli/compatibility.js');
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NAKH_ENV: 'test',
      NAKH_SERVICE_NAME: 'migration',
      NAKH_RELEASE: 'a'.repeat(40),
      NAKH_DATABASE_URL: isolated.url,
      NAKH_REDIS_URL: 'redis://localhost:6379',
      NAKH_TELEGRAM_BOT_TOKEN_REF: 'TEST_BOT',
      NAKH_TELEGRAM_WEBHOOK_SECRET: 'PRIVATE_SCHEMA_TEST_WEBHOOK_0000000000000000',
      NAKH_R2_ENDPOINT: 'https://r2.invalid',
      NAKH_R2_BUCKET: 'test',
      NAKH_R2_ACCESS_KEY_REF: 'TEST_R2_ACCESS',
      NAKH_R2_SECRET_KEY_REF: 'TEST_R2_SECRET',
      NAKH_MEDIA_CDN_HOST: 'media.invalid',
      NAKH_MEDIA_SIGNING_KEY_REF: 'TEST_SIGNING_KEY',
    };
    const execute = (release = env.NAKH_RELEASE): Promise<{ stdout: string; stderr: string }> =>
      promisify(execFile)(process.execPath, ['--no-opt', cli], {
        cwd: directory,
        env: { ...env, NAKH_RELEASE: release },
        timeout: 20000,
        maxBuffer: 65536,
      });
    try {
      for (const file of files)
        await copyFile(join(resolve('migrations'), file.name), join(migrationDirectory, file.name));
      const result = await execute();
      expect(JSON.parse(result.stdout)).toEqual({
        compatible: true,
        sourceSha: env.NAKH_RELEASE,
        ...(await verify()),
      });
      expect(result.stderr).toBe('');
      await expect(execute('PRIVATE_SOURCE_VALUE')).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr:
          'Selected image schema compatibility could not be verified. Activation is denied.\n',
      });
      await unlink(join(migrationDirectory, files.at(-1)!.name));
      await expect(execute()).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr:
          'Selected image schema compatibility could not be verified. Activation is denied.\n',
      });
    } finally {
      for (const file of await readdir(migrationDirectory))
        await unlink(join(migrationDirectory, file));
      await rmdir(migrationDirectory);
      await rmdir(directory);
    }
  });
  it('observes the new committed ledger after waiting for the original migration lock', async () => {
    let release!: () => void, held!: () => void;
    const ready = new Promise<void>((resolve) => {
        held = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const writer = database.connection().execute(async (conn) => {
      await sql`SELECT pg_advisory_lock(hashtext('nakh-schema-migrations'))`.execute(conn);
      try {
        held();
        await gate;
        await sql`INSERT INTO platform.schema_migrations(name,sha256) VALUES('999999_waited.sql',${'2'.repeat(64)})`.execute(
          conn,
        );
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtext('nakh-schema-migrations'))`.execute(conn);
      }
    });
    await ready;
    const pending = verify();
    try {
      let observed = false;
      for (let i = 0; i < 500; i++) {
        const result = await sql<{
          waiting: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='nakh-schema-compatibility' AND wait_event_type='Lock') AS waiting`.execute(
          database,
        );
        if (result.rows[0]?.waiting) {
          observed = true;
          break;
        }
        await delay(10);
      }
      expect(observed).toBe(true);
      release();
      await writer;
      await expect(pending).rejects.toThrow('Selected image schema is not compatible.');
    } finally {
      release();
      await writer;
      await pending.catch(() => undefined);
      await sql`DELETE FROM platform.schema_migrations WHERE name='999999_waited.sql'`.execute(
        database,
      );
    }
    expect((await verify()).migrations).toBe(159);
  });
});
