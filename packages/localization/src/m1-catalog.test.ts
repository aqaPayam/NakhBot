import { describe, expect, it } from 'vitest';

import { routeStart } from '@nakh/application';

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
    const migration = (
      await Promise.all(
        [
          '000002_m1_identity_localization.sql',
          '000003_m1_identity_start.sql',
          '000004_m1_settings.sql',
        ].map((name) => readFile(resolve(process.cwd(), 'migrations', name), 'utf8')),
      )
    ).join('\n');
    for (const entry of M1_LOCALIZATION_MANIFEST) {
      expect(migration).toContain(`'${entry.key}'`);
      expect(migration).toContain(`'${entry.english.replaceAll("'", "''")}'`);
    }
  });

  it('covers every localization key emitted by the start router', () => {
    const catalog = englishCatalogFromManifest();
    const routes = [
      'guest',
      'continue_signup',
      'main',
      'main_discovery_paused',
      'fix_profile',
      'restricted',
      'ban_appeal',
      'return_decision',
    ] as const;
    for (const route of routes) {
      const view = routeStart(route);
      expect(catalog[view.title.key], view.title.key).toBeDefined();
      for (const item of view.actions) {
        expect(catalog[item.label.key], item.label.key).toBeDefined();
      }
    }
  });

  it('requires application error handlers to emit catalog keys instead of prose', async () => {
    const catalog = englishCatalogFromManifest();
    const sources = await Promise.all(
      [
        'packages/application/src/identity/change-settings.ts',
        'packages/application/src/access/capability-authorizer.ts',
      ].map((name) => readFile(resolve(process.cwd(), name), 'utf8')),
    );
    const keys = sources.flatMap((source) =>
      [...source.matchAll(/new ApplicationError\(\s*'[^']+'\s*,\s*'([^']+)'/gu)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    );

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^error\./u);
      expect(catalog[key], key).toBeDefined();
    }
  });
});
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
