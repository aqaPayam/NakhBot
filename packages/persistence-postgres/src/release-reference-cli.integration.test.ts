import { spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { runMigrations } from './migrations.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('compiled private release reference command', () => {
  it('captures and verifies a native snapshot, rejects drift, overwrite and wrong source, and keeps references private', async () => {
    const isolated = await createIsolatedTestDatabase(url!, 'm9_reference_cli');
    const directory = await mkdtemp(join(tmpdir(), 'nakh-reference-cli-'));
    try {
      await runMigrations(isolated.url, resolve('migrations'));
      const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const env = {
        ...process.env,
        NAKH_ENV: 'staging',
        NAKH_SERVICE_NAME: 'api',
        NAKH_RELEASE: source,
        NAKH_DATABASE_URL: isolated.url,
        NAKH_DATABASE_ROLE_ISOLATION_ENABLED: 'false',
        NAKH_REDIS_URL: 'redis://localhost:6379/0',
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'TEST_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: 'PRIVATE_WEBHOOK_SECRET_0000000000000000',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'TEST_R2_ACCESS',
        NAKH_R2_SECRET_KEY_REF: 'TEST_R2_SECRET',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'TEST_SIGNING_KEY',
      };
      const invoke = (action: string, file: string, release = source): SpawnSyncReturns<string> =>
        spawnSync(
          process.execPath,
          [resolve('packages/persistence-postgres/dist/cli/release-reference.js'), action, file],
          {
            env: { ...env, NAKH_RELEASE: release },
            encoding: 'utf8',
            timeout: 60000,
          },
        );
      const file = join(directory, 'reference.json');
      const captured = invoke('--capture', file);
      expect(captured.status, captured.stderr).toBe(0);
      expect(JSON.parse(captured.stdout)).toMatchObject({
        captured: true,
        sourceSha: source,
        service: 'api',
        tables: 24,
      });
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
      const original = await readFile(file, 'utf8');
      expect(invoke('--capture', file).status).toBe(1);
      expect(await readFile(file, 'utf8')).toBe(original);
      const verified = invoke('--verify', file);
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({ matches: true, sourceSha: source });
      const changed = JSON.parse(original) as { native: Record<string, { value?: string }[]> };
      const row = changed.native['catalog.ui_texts']?.find((row) => typeof row.value === 'string');
      if (row === undefined) throw new Error('Native reference text fixture unavailable.');
      row.value = (row.value ?? '') + ' drift';
      await writeFile(file, JSON.stringify(changed));
      const mismatch = invoke('--verify', file);
      expect(mismatch.status, mismatch.stderr).toBe(1);
      expect(JSON.parse(mismatch.stdout)).toMatchObject({ matches: false });
      const rejected = join(directory, 'wrong-source.json');
      const wrong = invoke('--capture', rejected, '0'.repeat(40));
      expect(wrong.status).toBe(1);
      expect(wrong.stderr.trim()).toBe(
        'Release reference verification failed. No activation or approval is authorized.',
      );
      await expect(stat(rejected)).rejects.toThrow();
      expect(captured.stdout).not.toContain('PRIVATE_');
      expect(verified.stdout).not.toContain('PRIVATE_');
    } finally {
      try {
        await isolated.destroy();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
