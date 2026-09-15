import { describe, expect, it } from 'vitest';

import type { OpaqueTokenStore } from '@nakh/application';

import { TelegramPhotoActionTokens } from './action-token.js';

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

const state = {
  telegramUserId: '123456789',
  expectedProfileVersion: 7,
  action: {
    type: 'select_primary' as const,
    photoId: '40000000-0000-4000-8000-000000000000',
  },
};

describe('TelegramPhotoActionTokens', () => {
  it('issues a callback-sized opaque token and resolves its server-side state', async () => {
    const store = new MemoryTokens();
    const tokens = new TelegramPhotoActionTokens(
      store,
      new Uint8Array(32).fill(7),
      () => 1_000,
      () => 'abcdefghijklmnop',
    );
    const token = await tokens.issue(state, 60);
    expect(token).toBe('v1.pm.abcdefghijklmnop.83u2A2bTH5JUrFIB');
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).not.toContain(state.telegramUserId);
    expect(token).not.toContain(state.action.photoId);
    await expect(tokens.resolve(token, state.telegramUserId)).resolves.toEqual(state);
  });

  it('rejects tampering, cross-user replay, expiry, and missing state indistinguishably', async () => {
    let now = 1_000;
    const store = new MemoryTokens();
    const tokens = new TelegramPhotoActionTokens(
      store,
      new Uint8Array(32).fill(7),
      () => now,
      () => 'abcdefghijklmnop',
    );
    const token = await tokens.issue(state, 60);
    await expect(
      tokens.resolve(`${token.slice(0, -1)}x`, state.telegramUserId),
    ).resolves.toBeUndefined();
    await expect(tokens.resolve(token, '987654321')).resolves.toBeUndefined();
    now = 61_001;
    await expect(tokens.resolve(token, state.telegramUserId)).resolves.toBeUndefined();
    store.values.clear();
    await expect(tokens.resolve(token, state.telegramUserId)).resolves.toBeUndefined();
  });

  it('rejects invalid state and bounds allocation collisions', async () => {
    const store = new MemoryTokens();
    store.values.set('abcdefghijklmnop', '{}');
    const tokens = new TelegramPhotoActionTokens(
      store,
      new Uint8Array(32).fill(7),
      () => 1_000,
      () => 'abcdefghijklmnop',
    );
    await expect(tokens.issue(state, 60)).rejects.toThrow('allocation failed');
    await expect(tokens.issue({ ...state, expectedProfileVersion: 0 }, 60)).rejects.toThrow(
      'state is invalid',
    );
  });
});
