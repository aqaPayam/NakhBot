import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { M5_LOCALIZATION_ENTRIES } from './m5-catalog.js';

describe('M5 localization manifest', () => {
  it('has unique keys and exact variable declarations', () => {
    const keys = M5_LOCALIZATION_ENTRIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of M5_LOCALIZATION_ENTRIES) {
      const used = [...entry.english.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((match) => match[1]);
      expect([...entry.variables].sort(), entry.key).toEqual(used.sort());
    }
  });

  it('keeps every English entry synchronized with the forward-only migration', async () => {
    const migration = await readFile(
      resolve(process.cwd(), 'migrations', '000035_m5_localization.sql'),
      'utf8',
    );
    for (const entry of M5_LOCALIZATION_ENTRIES) {
      expect(migration, entry.key).toContain(`'${entry.key}'`);
      expect(migration, entry.key).toContain(`'${entry.english.replaceAll("'", "''")}'`);
      expect(migration, entry.key).toContain(JSON.stringify(entry.variables));
    }
  });

  it('renders a rejected Nakh as Closed without merging its stored status', () => {
    const rejected = M5_LOCALIZATION_ENTRIES.find((entry) => entry.key === 'nakh.status.rejected');
    const closed = M5_LOCALIZATION_ENTRIES.find((entry) => entry.key === 'nakh.status.closed');
    expect(rejected?.english).toBe('Closed');
    expect(closed?.english).toBe('Closed');
    expect(rejected?.key).not.toBe(closed?.key);
  });
});
