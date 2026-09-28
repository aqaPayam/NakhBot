import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CatalogRenderer } from './index.js';
import { M7_LOCALIZATION_ENTRIES } from './m7-catalog.js';

describe('M7 localization and static prose gate', () => {
  const catalog = Object.fromEntries(M7_LOCALIZATION_ENTRIES.map((e) => [e.key, e.english]));
  it('provides a complete English fallback with no sensitive interpolation variables', () => {
    expect(Object.keys(catalog)).toHaveLength(M7_LOCALIZATION_ENTRIES.length);
    const renderer = new CatalogRenderer({ en: catalog });
    for (const entry of M7_LOCALIZATION_ENTRIES) {
      expect(entry.variables).toEqual([]);
      expect(entry.english).not.toMatch(/\{[^}]*\}/u);
      expect(renderer.render('fa', { key: entry.key, variables: {} })).toBe(entry.english);
    }
    expect(Object.keys(catalog).filter((key) => key.startsWith('report.reason.'))).toHaveLength(7);
  });
  it('keeps migration and verification SQL synchronized with all entries', async () => {
    const migration = await readFile(resolve('migrations/000054_m7_localization.sql'), 'utf8');
    const verification = await readFile(
      resolve('migrations/verify/000054_m7_localization.sql'),
      'utf8',
    );
    for (const entry of M7_LOCALIZATION_ENTRIES) {
      expect(migration).toContain(`'${entry.key}'`);
      expect(migration).toContain(`'${entry.english.replaceAll("'", "''")}'`);
      expect(verification).toContain(`'${entry.key}'`);
    }
  });
  it('covers emitted M7 keys and forbids prose in M7 application errors', async () => {
    const directories = [
      'packages/application/src/moderation',
      'packages/application/src/administration',
      'packages/application/src/support',
      'packages/domain/src/moderation',
    ];
    const files: string[] = [
      'packages/telegram/src/m7-presentation.ts',
      'packages/telegram/src/support-appeal-adapter.ts',
      'apps/telegram-gateway/src/support-appeal-ingress.ts',
    ];
    for (const directory of directories) {
      for (const file of await readdir(resolve(directory)))
        if (file.endsWith('.ts') && !file.endsWith('.test.ts')) files.push(`${directory}/${file}`);
    }
    for (const file of await readdir(resolve('packages/persistence-postgres/src'))) {
      if (
        /^(?:appeal|support|moderation|account-moderation|photo-moderation|internal-block|admin)-.*(?<!\.test)\.ts$/u.test(
          file,
        )
      )
        files.push(`packages/persistence-postgres/src/${file}`);
    }
    for (const file of files) {
      const source = await readFile(resolve(file), 'utf8');
      for (const match of source.matchAll(/new ApplicationError\(\s*'[^']+'\s*,\s*'([^']+)'/gu))
        expect(match[1], file).toMatch(/^error\.[a-z0-9_.]+$/u);
      const keyPattern =
        file.startsWith('packages/telegram/') || file.endsWith('/user-contact.ts')
          ? /'((?:error\.(?:m7|report|moderation|admin|support|appeal)|report|support|appeal|admin\.outcome)\.[a-z0-9_.]+)'/gu
          : /'((?:error\.(?:m7|report|moderation|admin|support|appeal)|notification\.(?:restriction_warning|ban_warning|account_unrestricted|account_unbanned)|report\.reason)\.[a-z0-9_.]+)'/gu;
      for (const match of source.matchAll(keyPattern))
        expect(catalog[match[1]!], `${file}: ${match[1]}`).toBeDefined();
    }
  });
});
