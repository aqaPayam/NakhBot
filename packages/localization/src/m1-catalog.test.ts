import { describe, expect, it } from 'vitest';

import { routeSignup, routeStart } from '@nakh/application';

import {
  M1_CATALOG_LOCALIZATION_ENTRIES,
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
          '000005_m1_profile_catalogs.sql',
          '000006_m1_signup_profile.sql',
        ].map((name) => readFile(resolve(process.cwd(), 'migrations', name), 'utf8')),
      )
    ).join('\n');
    for (const entry of M1_LOCALIZATION_MANIFEST) {
      if (M1_CATALOG_LOCALIZATION_ENTRIES.includes(entry)) {
        expect(migration).toContain(`'${entry.key.split('.').at(-1)}'`);
      } else {
        expect(migration).toContain(`'${entry.key}'`);
        expect(migration).toContain(`'${entry.english.replaceAll("'", "''")}'`);
      }
    }
  });

  it('covers every durable signup resume prompt', () => {
    const catalog = englishCatalogFromManifest();
    const steps = [
      'age_confirmation',
      'name',
      'birth_year',
      'gender',
      'relationship_gender_preference',
      'interests',
      'location',
      'relationship_goal',
      'primary_photo',
      'additional_photos',
      'highlight',
      'optional_details',
      'confirm_profile',
      'completed',
    ] as const;
    for (const currentStep of steps) {
      const view = routeSignup({
        currentStep,
        draftVersion: 1,
        updatedAt: '2026-09-04T00:00:00.000Z',
      });
      expect(catalog[view.prompt.key], view.prompt.key).toBeDefined();
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
        'packages/application/src/identity/signup.ts',
        'packages/persistence-postgres/src/signup-store.ts',
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
