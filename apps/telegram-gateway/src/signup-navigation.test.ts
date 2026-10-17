import { describe, expect, it } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import { SignupNavigationTokens, type SignupNavigation } from './signup-navigation.js';
const life = { userId: '10000000-0000-4000-8000-000000000001', productEpoch: 0 };
const actor = {
  kind: 'user' as const,
  ...life,
  sessionGrantId: '20000000-0000-4000-8000-000000000001',
};
function fixture(): {
  data: Map<string, string>;
  store: OpaqueTokenStore;
  tokens: SignupNavigationTokens;
  nav: SignupNavigation;
} {
  const data = new Map<string, string>();
  const store: OpaqueTokenStore = {
    get: (id) => Promise.resolve(data.get(id)),
    putIfAbsent: (id, value) => {
      if (data.has(id)) return Promise.resolve(false);
      data.set(id, value);
      return Promise.resolve(true);
    },
  };
  return {
    data,
    store,
    tokens: new SignupNavigationTokens(store, Buffer.alloc(32, 1), '12345', '123', life),
    nav: { actor, version: 2, screen: 'name', action: 'resume', group: 'abcdefghijklmnop' },
  };
}
describe('signup navigation integrity and concurrency', () => {
  it('separates report callbacks, private reply bindings and claims from signup', async () => {
    const f = fixture(),
      reports = new SignupNavigationTokens(
        f.store,
        Buffer.alloc(32, 1),
        '12345',
        '123',
        life,
        undefined,
        'report',
      );
    const state: SignupNavigation = {
      ...f.nav,
      screen: 'report',
      reference: 'abcdefghijklmnop',
      reason: 'fake_profile',
      photoId: '30000000-0000-4000-8000-000000000001',
    };
    const report = await reports.button(state),
      signup = await f.tokens.button(f.nav);
    expect(report).toMatch(/^m9r:/u);
    expect(await f.tokens.callback(report)).toBeUndefined();
    expect(await reports.callback(signup)).toBeUndefined();
    expect(await reports.callback(report)).toEqual(state);
    expect(report).not.toContain(state.photoId);
    await expect(reports.button({ ...state, photoId: 'invalid-photo' })).rejects.toThrow(
      'navigation unavailable',
    );
    await expect(f.tokens.button({ ...f.nav, photoId: state.photoId })).rejects.toThrow(
      'navigation unavailable',
    );
    await reports.prompt(123, { ...state, action: 'reply' });
    expect(await f.tokens.reply(123)).toBeUndefined();
    expect((await reports.reply(123))?.reason).toBe('fake_profile');
    expect(reports.replyId(123)).not.toBe(f.tokens.replyId(123));
    expect((await reports.claim(state, 1, report, state)).accepted).toBe(true);
    expect((await f.tokens.claim(f.nav, 2, signup, f.nav)).accepted).toBe(true);
  });
  it('keeps Show More bound to its owner and opaque delivered-card reference', async () => {
    const f = fixture(),
      delivery = '30000000-0000-4000-8000-000000000001';
    const nav: SignupNavigation = { ...f.nav, screen: 'preview', action: 'detail', code: delivery };
    const token = await f.tokens.button(nav);
    expect(token).not.toContain(delivery);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);
    expect(await f.tokens.callback(token)).toEqual(nav);
    const borrowed = new SignupNavigationTokens(f.store, Buffer.alloc(32, 1), '12345', '456', life);
    expect(await borrowed.callback(token)).toBeUndefined();
    for (const action of [
      'explore',
      'like',
      'reject',
      'nakh',
      'nakh_credits',
      'nakh_pending',
      'nakh_stars',
    ] as const) {
      const explore = { ...nav, screen: 'explore', action };
      const reference = await f.tokens.button(explore);
      expect(reference).not.toContain(delivery);
      expect(await f.tokens.callback(reference)).toEqual(explore);
      expect(await borrowed.callback(reference)).toBeUndefined();
    }
  });
  it('binds callback ownership, bot, life and purpose with no form values', async () => {
    const f = fixture(),
      token = await f.tokens.button(f.nav);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);
    expect(await f.tokens.callback(token)).toEqual(f.nav);
    for (const t of [
      new SignupNavigationTokens(f.store, Buffer.alloc(32, 1), '12345', '456', life),
      new SignupNavigationTokens(f.store, Buffer.alloc(32, 1), '99999', '123', life),
      new SignupNavigationTokens(f.store, Buffer.alloc(32, 1), '12345', '123', {
        ...life,
        productEpoch: 1,
      }),
      new SignupNavigationTokens(f.store, Buffer.alloc(32, 2), '12345', '123', life),
    ])
      expect(await t.callback(token)).toBeUndefined();
    await expect(
      f.tokens.button({ ...f.nav, privateText: 'private-name' } as SignupNavigation),
    ).rejects.toThrow('navigation unavailable');
    expect([...f.data.values()].join('')).not.toContain('private-name');
  });
  it('binds free text to the exact bot prompt independently of callback tokens', async () => {
    const f = fixture();
    const issuing = new SignupNavigationTokens(f.store, Buffer.alloc(32, 1), '12345', '123', actor);
    await issuing.prompt(11, { ...f.nav, action: 'reply' });
    expect(await f.tokens.reply(11)).toEqual({ ...f.nav, action: 'reply' });
    expect(await f.tokens.reply(12)).toBeUndefined();
    const token = await f.tokens.button(f.nav);
    expect(await f.tokens.callback(token.replace(/.$/u, '!'))).toBeUndefined();
    const raw = f.data.get(f.tokens.replyId(11))!;
    const mac = JSON.parse(raw) as { mac: string };
    expect(await f.tokens.callback(`m9s:${f.tokens.replyId(11)}:${mac.mac}`)).toBeUndefined();
  });
  it('rejects body substitution and explicit expiry even if cache TTL is ignored', async () => {
    const f = fixture(),
      token = await f.tokens.button(f.nav),
      id = token.split(':')[1]!;
    f.data.set(id, f.data.get(id)!.replace('"version\\":2', '"version\\":3'));
    // Change a byte unconditionally, independent of serialization escaping.
    const original = JSON.parse(f.data.get(id)!) as { body: string; mac: string };
    original.body += ' ';
    f.data.set(id, JSON.stringify(original));
    expect(await f.tokens.callback(token)).toBeUndefined();
    const other = fixture();
    let now = 1000000;
    const timed = new SignupNavigationTokens(
      other.store,
      Buffer.alloc(32, 1),
      '12345',
      '123',
      life,
      () => now,
    );
    const valid = await timed.button(other.nav);
    now += 900001;
    expect(await timed.callback(valid)).toBeUndefined();
  });
  it('keeps the first menu transition across simultaneous clicks and exact retries', async () => {
    const f = fixture(),
      one = { ...f.nav, selection: ['music'] },
      two = { ...f.nav, selection: ['books'] };
    const results = await Promise.all([
      f.tokens.claim(f.nav, 1, 'callback-one', one),
      f.tokens.claim(f.nav, 2, 'callback-two', two),
    ]);
    expect(results.map((r) => r.accepted)).toEqual([true, false]);
    expect(results[1]?.next.selection).toEqual(['music']);
    expect((await f.tokens.claim(f.nav, 1, 'callback-one', one)).accepted).toBe(true);
    expect((await f.tokens.claim(f.nav, 1, 'changed-body', two)).accepted).toBe(false);
    const key = [...f.data.keys()][0]!;
    f.data.set(key, '{}');
    await expect(f.tokens.claim(f.nav, 1, 'callback-one', one)).rejects.toThrow();
  });
});
