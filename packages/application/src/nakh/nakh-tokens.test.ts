import { describe, expect, it } from 'vitest';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import { NakhOpaqueReferences } from './nakh-tokens.js';

class MemoryTokens implements OpaqueTokenStore {
  public readonly values = new Map<string, string>();

  public putIfAbsent(id: string, value: string): Promise<boolean> {
    if (this.values.has(id)) return Promise.resolve(false);
    this.values.set(id, value);
    return Promise.resolve(true);
  }

  public get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(id));
  }
}

const viewer = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const requestId = '20000000-0000-4000-8000-000000000001';
const position = {
  sentAt: new Date('2026-09-23T00:00:00.000Z'),
  nakhId: '30000000-0000-4000-8000-000000000001',
};

describe('delivered Nakh opaque cursors', () => {
  it('binds hidden pagination state to viewer and direction', async () => {
    const tokens = new NakhOpaqueReferences(
      new MemoryTokens(),
      new Uint8Array(32).fill(4),
      () => 1_000,
      () => 'abcdefghijklmnop',
    );
    const cursor = await tokens.issueCursor(viewer, 'received', position, requestId);
    expect(cursor).toMatch(/^v1\.nk\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(cursor).not.toContain(position.nakhId);
    await expect(tokens.resolveCursor(cursor, viewer, 'received')).resolves.toEqual(position);
    await expect(tokens.resolveCursor(cursor, viewer, 'sent')).resolves.toBeUndefined();
    await expect(tokens.resolveCursor(cursor, other, 'received')).resolves.toBeUndefined();
  });

  it('rejects tampering and expiration', async () => {
    let now = 1_000;
    const tokens = new NakhOpaqueReferences(
      new MemoryTokens(),
      new Uint8Array(32).fill(4),
      () => now,
      () => 'abcdefghijklmnop',
    );
    const cursor = await tokens.issueCursor(viewer, 'sent', position);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    await expect(tokens.resolveCursor(tampered, viewer, 'sent')).resolves.toBeUndefined();
    now = 901_001;
    await expect(tokens.resolveCursor(cursor, viewer, 'sent')).resolves.toBeUndefined();
  });
});
