import { describe, expect, it } from 'vitest';

import {
  M1_LOCALIZATION_MANIFEST,
  englishCatalogFromManifest,
  validateLocalizationManifest,
} from './index.js';

describe('M1 localization manifest', () => {
  it('has unique keys and exact variable declarations', () => {
    expect(validateLocalizationManifest()).toEqual([]);
  });

  it('creates the required English catalog without prose in handlers', () => {
    const catalog = englishCatalogFromManifest();
    expect(Object.keys(catalog)).toHaveLength(M1_LOCALIZATION_MANIFEST.length);
    expect(catalog['start.guest.title']).toBe('Welcome to Nakh');
  });

  it('keeps the database seed synchronized with the manifest', async () => {
    const migration = await readFile(
      resolve(process.cwd(), 'migrations/000002_m1_identity_localization.sql'),
      'utf8',
    );
    for (const entry of M1_LOCALIZATION_MANIFEST) {
      expect(migration).toContain(`'${entry.key}'`);
      expect(migration).toContain(`'${entry.english.replaceAll("'", "''")}'`);
    }
  });
});
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
