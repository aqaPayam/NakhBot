import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { M6_LOCALIZATION_ENTRIES } from './m6-catalog.js';

describe('M6 localization manifest', () => {
  it('has unique keys, bounded categories, and exact variable declarations', () => {
    const keys = M6_LOCALIZATION_ENTRIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of M6_LOCALIZATION_ENTRIES) {
      const used = [...entry.english.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((match) => match[1]);
      expect([...entry.variables].sort(), entry.key).toEqual(used.sort());
    }
  });

  it('keeps every English entry synchronized with the forward-only migration', async () => {
    const migration = await readFile(
      resolve(process.cwd(), 'migrations', '000044_m6_localization.sql'),
      'utf8',
    );
    for (const entry of M6_LOCALIZATION_ENTRIES) {
      expect(migration, entry.key).toContain(`'${entry.key}'`);
      expect(migration, entry.key).toContain(`'${entry.english.replaceAll("'", "''")}'`);
    }
  });

  it('contains every canonical prompt row and privacy-safe Telegram presentation key', () => {
    const keys = new Set(M6_LOCALIZATION_ENTRIES.map((entry) => entry.key));
    expect([...keys].filter((key) => key.startsWith('chat.prompt.'))).toHaveLength(67);
    expect(keys.size).toBe(98);
    expect(keys.has('notification.new_chat_message.body')).toBe(true);
    expect(keys.has('notification.chat_closed.body')).toBe(true);
    expect(keys.has('error.chat.snapshot_invalid')).toBe(true);
  });
});
