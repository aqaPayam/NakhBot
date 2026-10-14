import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CatalogRenderer, M8_LOCALIZATION_ENTRIES } from './index.js';
describe('M8 limited account controls localization', () => {
  it('renders every fixed notice and button in English fallback without private interpolation', () => {
    const catalog = Object.fromEntries(M8_LOCALIZATION_ENTRIES.map((e) => [e.key, e.english])),
      renderer = new CatalogRenderer({ en: catalog });
    expect(Object.keys(catalog)).toHaveLength(M8_LOCALIZATION_ENTRIES.length);
    for (const entry of M8_LOCALIZATION_ENTRIES) {
      expect(entry.variables).toEqual([]);
      expect(entry.english).not.toMatch(/\{[^}]*\}/u);
      expect(renderer.render('fa', { key: entry.key, variables: {} })).toBe(entry.english);
    }
  });
  it('keeps every emitted key synchronized with native migration, verification and catalog', async () => {
    const migration = await readFile('migrations/000140_m8_deletion_localization.sql', 'utf8'),
      verification = await readFile(
        'migrations/verify/000140_m8_deletion_localization.sql',
        'utf8',
      ),
      adapter = await readFile('packages/telegram/src/account-deletion-adapter.ts', 'utf8');
    for (const entry of M8_LOCALIZATION_ENTRIES) {
      expect(migration).toContain(`'${entry.key}'`);
      expect(migration).toContain(`'${entry.english.replaceAll("'", "''")}'`);
      expect(verification).toContain(`'${entry.key}'`);
    }
    const keys = new Set(M8_LOCALIZATION_ENTRIES.map((e) => e.key));
    for (const match of adapter.matchAll(/'(deletion\.[a-z_.]+)'/gu))
      expect(keys.has(match[1]!)).toBe(true);
  });
});
