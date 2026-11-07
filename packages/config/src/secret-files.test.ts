import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig, resolveSecretReference } from './index.js';

function fixture(): {
  directory: string;
  file: (name: string, body: string | Uint8Array, mode?: number) => string;
  dispose: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'nakh-private-config-'));
  return {
    directory,
    file: (name, body, mode = 0o600) => {
      const path = join(directory, name);
      writeFileSync(path, body, { mode });
      chmodSync(path, mode);
      return path;
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
describe('private secret source selection', () => {
  it('rejects conflicting values before touching a file and keeps existing environment refs unchanged', () => {
    expect(resolveSecretReference('TEST_PRIVATE', { TEST_PRIVATE: 'existing' })).toBe('existing');
    for (const value of ['', 'PRIVATE_DO_NOT_PRINT'])
      expect(() =>
        resolveSecretReference('TEST_PRIVATE', {
          TEST_PRIVATE: value,
          TEST_PRIVATE_FILE: '/not/a/real/file',
        }),
      ).toThrow('Conflicting secret sources.');
  });
});
describe.skipIf(process.platform !== 'linux')('Linux mounted runtime secrets', () => {
  it('reads a private file, strips one final line ending and preserves structured keyring text', () => {
    const f = fixture();
    try {
      const keyring = '[\n  {"keyId":"synthetic-private-key","version":1}\n]';
      expect(
        resolveSecretReference('TEST_PRIVATE', {
          TEST_PRIVATE_FILE: f.file('keyring', keyring + '\r\n'),
        }),
      ).toBe(keyring);
    } finally {
      f.dispose();
    }
  });
  it('rejects readable-by-others files, links, directories and noncanonical paths without exposing contents', () => {
    const f = fixture();
    try {
      const file = f.file('private', 'PRIVATE_DO_NOT_PRINT'),
        publicFile = f.file('public', 'PRIVATE_DO_NOT_PRINT', 0o644);
      const symbolic = join(f.directory, 'symbolic');
      symlinkSync(file, symbolic);
      const directory = join(f.directory, 'directory');
      mkdirSync(directory);
      for (const path of [
        publicFile,
        symbolic,
        directory,
        'relative/private',
        f.directory + '/../private',
      ])
        expect(() => resolveSecretReference('TEST_PRIVATE', { TEST_PRIVATE_FILE: path })).toThrow(
          'Required secret is unavailable.',
        );
      const hard = join(f.directory, 'hard');
      linkSync(file, hard);
      expect(() => resolveSecretReference('TEST_PRIVATE', { TEST_PRIVATE_FILE: hard })).toThrow(
        'Required secret is unavailable.',
      );
      expect(() => resolveSecretReference('TEST_PRIVATE', { TEST_PRIVATE_FILE: file })).toThrow(
        'Required secret is unavailable.',
      );
    } finally {
      f.dispose();
    }
  });
  it('rejects empty, oversized, invalid UTF-8 and NUL-containing files', () => {
    const f = fixture();
    try {
      const values = ['', 'x'.repeat(65537), new Uint8Array([255]), 'private\0secret'];
      for (const [index, value] of values.entries())
        expect(() =>
          resolveSecretReference('TEST_PRIVATE', {
            TEST_PRIVATE_FILE: f.file('bad' + index, value),
          }),
        ).toThrow('Required secret is unavailable.');
    } finally {
      f.dispose();
    }
  });
  it('loads database and Redis URLs from private files without changing the supplied environment or resolving unrelated secrets', () => {
    const f = fixture();
    try {
      const env: NodeJS.ProcessEnv = {
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'test',
        NAKH_DATABASE_URL_FILE: f.file(
          'database',
          'postgresql://test:PRIVATE_DB_PASSWORD@localhost/test\n',
        ),
        NAKH_REDIS_URL_FILE: f.file(
          'redis',
          'rediss://default:PRIVATE_REDIS_PASSWORD@localhost:6379\n',
        ),
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'TEST_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET_FILE: f.file('webhook', '12345678901234567890123456789012\n'),
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'TEST_ACCESS',
        NAKH_R2_SECRET_KEY_REF: 'TEST_SECRET',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'TEST_SIGNING',
      };
      const config = loadConfig(env);
      expect(config.database.url).toBe('postgresql://test:PRIVATE_DB_PASSWORD@localhost/test');
      expect(config.redis.url).toBe('rediss://default:PRIVATE_REDIS_PASSWORD@localhost:6379');
      expect(config.media.accessKeyRef).toBe('TEST_ACCESS');
      expect(config.telegram.webhookSecret).toBe('12345678901234567890123456789012');
      expect(env.NAKH_TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
      expect(env.NAKH_DATABASE_URL).toBeUndefined();
      expect(env.NAKH_REDIS_URL).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});
