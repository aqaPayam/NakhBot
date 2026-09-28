import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AdminConfirmationTokens } from './admin-confirmation.js';
import type { OpaqueTokenStore } from '../security/opaque-token.js';

describe('Admin confirmation tokens', () => {
  it('stores only a digest and rejects changed bindings, tampering, wrong purpose and expiry', async () => {
    const rows = new Map<string, string>();
    const store: OpaqueTokenStore = {
      putIfAbsent: (id, value) => {
        if (rows.has(id)) return Promise.resolve(false);
        rows.set(id, value);
        return Promise.resolve(true);
      },
      get: (id) => Promise.resolve(rows.get(id)),
    };
    let now = 1_800_000_000_000;
    const tokens = new AdminConfirmationTokens(store, Buffer.alloc(32, 1), () => now);
    const digest = createHash('sha256').update('private reason and selected target').digest('hex');
    const token = await tokens.issue(digest);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);
    expect(await tokens.matches(token, digest)).toBe(true);
    expect(await tokens.matches(token, 'a'.repeat(64))).toBe(false);
    expect(await tokens.matches(token.replace('v1.cf', 'v1.ad'), digest)).toBe(false);
    const tampered = token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x');
    expect(await tokens.matches(tampered, digest)).toBe(false);
    expect([...rows.values()].join()).not.toContain('private reason');
    now += 300_000;
    expect(await tokens.matches(token, digest)).toBe(false);
    rows.clear();
    expect(await tokens.matches(token, digest)).toBe(false);
  });
});
