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
  it.each(['signup', 'report', 'chat', 'account', 'profile', 'liked_by', 'nakh'] as const)(
    'isolates purchase confirmation from %s navigation',
    async (purpose) => {
      const f = fixture(),
        key = Buffer.alloc(32, 1);
      const purchases = new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '123',
        life,
        undefined,
        'purchase',
      );
      const other = new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '123',
        life,
        undefined,
        purpose,
      );
      const nav: SignupNavigation = {
        ...f.nav,
        screen: 'purchase_review',
        action: 'save',
        reference: 'a'.repeat(64),
        reason: 'b'.repeat(64),
        code: '30000000-0000-4000-8000-000000000001',
      };
      const value = await purchases.button(nav);
      expect(value).toMatch(/^m9b:/u);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
      expect(value).not.toContain(nav.code);
      expect(await purchases.callback(value)).toEqual(nav);
      expect(await other.callback(value)).toBeUndefined();
      const foreign = await other.button(nav);
      expect(await purchases.callback(foreign.replace(/^[^:]+:/u, 'm9b:'))).toBeUndefined();
    },
  );
  it('isolates Nakh selectors from signup, Like, reporting, other recipients and later lives', async () => {
    const f = fixture(),
      key = Buffer.alloc(32, 1);
    const tokens = new SignupNavigationTokens(
      f.store,
      key,
      '12345',
      '123',
      life,
      undefined,
      'nakh',
    );
    const nav: SignupNavigation = {
      ...f.nav,
      screen: 'detail',
      action: 'finish',
      field: 'received',
      reference: '30000000-0000-4000-8000-000000000001',
    };
    const value = await tokens.button(nav);
    expect(value).toMatch(/^m9n:/u);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(await tokens.callback(value)).toEqual(nav);
    for (const purpose of ['signup', 'liked_by', 'report'] as const)
      expect(
        await new SignupNavigationTokens(
          f.store,
          key,
          '12345',
          '123',
          life,
          undefined,
          purpose,
        ).callback(value),
      ).toBeUndefined();
    expect(
      await new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '124',
        life,
        undefined,
        'nakh',
      ).callback(value),
    ).toBeUndefined();
    expect(
      await new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '123',
        { ...life, productEpoch: 1 },
        undefined,
        'nakh',
      ).callback(value),
    ).toBeUndefined();
    await expect(tokens.button({ ...nav, likeId: nav.reference })).rejects.toThrow();
    await expect(tokens.button({ ...nav, unlockId: nav.reference })).rejects.toThrow();
  });
  it('reuses worker buttons under concurrent retries without renewing their original expiry', async () => {
    const f = fixture();
    let now = 1000;
    const tokens = new SignupNavigationTokens(
      f.store,
      Buffer.alloc(32, 1),
      '12345',
      '123',
      life,
      () => now,
      'liked_by',
    );
    const nav: SignupNavigation = {
      ...f.nav,
      screen: 'profile',
      action: 'like',
      likeId: '30000000-0000-4000-8000-000000000001',
      unlockId: '40000000-0000-4000-8000-000000000001',
      code: undefined,
    };
    const buttons = await Promise.all(
      Array.from({ length: 20 }, () => tokens.stableButton(nav, 'delivery:photo:1')),
    );
    expect(new Set(buttons).size).toBe(1);
    expect(f.data.size).toBe(1);
    expect(buttons[0]).toMatch(/^m9l:/u);
    expect(await tokens.callback(buttons[0]!)).toEqual({ ...nav, code: undefined });
    const original = [...f.data.values()][0];
    now += 899000;
    expect(await tokens.stableButton({ ...nav }, 'delivery:photo:1')).toBe(buttons[0]);
    expect([...f.data.values()][0]).toBe(original);
    now += 1000;
    await expect(tokens.stableButton(nav, 'delivery:photo:1')).rejects.toThrow();
    expect(await tokens.callback(buttons[0]!)).toBeUndefined();
  });
  it('keeps stable Like selectors isolated by purpose, recipient and original native session', async () => {
    const f = fixture(),
      key = Buffer.alloc(32, 1);
    const tokens = new SignupNavigationTokens(
      f.store,
      key,
      '12345',
      '123',
      life,
      undefined,
      'liked_by',
    );
    const nav: SignupNavigation = {
      ...f.nav,
      likeId: '30000000-0000-4000-8000-000000000001',
      unlockId: '40000000-0000-4000-8000-000000000001',
    };
    const token = await tokens.stableButton(nav, 'original-delivery');
    expect(await f.tokens.callback(token)).toBeUndefined();
    expect(
      await new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '124',
        life,
        undefined,
        'liked_by',
      ).callback(token),
    ).toBeUndefined();
    const changed = {
      ...nav,
      actor: { ...actor, sessionGrantId: '20000000-0000-4000-8000-000000000002' },
    };
    expect(await tokens.stableButton(changed, 'original-delivery')).not.toBe(token);
    await expect(f.tokens.button(nav)).rejects.toThrow();
    const id = token.split(':')[1]!,
      other = await tokens.stableButton(changed, 'other-delivery');
    f.data.set(id, f.data.get(other.split(':')[1]!)!);
    expect(await tokens.callback(token)).toBeUndefined();
  });
  it('keeps profile edit prompts and callbacks separate from account, signup and other product lives', async () => {
    const f = fixture(),
      key = Buffer.alloc(32, 1),
      make = (recipient = '123', epoch = 0): SignupNavigationTokens =>
        new SignupNavigationTokens(
          f.store,
          key,
          '12345',
          recipient,
          { ...life, productEpoch: epoch },
          undefined,
          'profile',
        );
    const editor = make(),
      nav: SignupNavigation = { ...f.nav, action: 'pick', screen: 'root', field: 'name' };
    const button = await editor.button(nav);
    expect(button).toMatch(/^m9p:/u);
    expect(await editor.callback(button)).toEqual(nav);
    expect(await f.tokens.callback(button)).toBeUndefined();
    expect(
      await new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '123',
        life,
        undefined,
        'account',
      ).callback(button),
    ).toBeUndefined();
    expect(await make('124').callback(button)).toBeUndefined();
    expect(await make('123', 1).callback(button)).toBeUndefined();
    await editor.prompt(123456, { ...nav, action: 'reply' });
    expect((await editor.reply(123456))?.actor.sessionGrantId).toBe(actor.sessionGrantId);
    expect(await f.tokens.reply(123456)).toBeUndefined();
  });
  it('binds credit callbacks to their original user, session, product life and account purpose', async () => {
    const f = fixture(),
      key = Buffer.alloc(32, 1);
    const account = new SignupNavigationTokens(
      f.store,
      key,
      '12345',
      '123',
      life,
      undefined,
      'account',
    );
    const nav: SignupNavigation = { ...f.nav, screen: 'credits', action: 'save', code: 'topup' };
    const button = await account.button(nav);
    expect(button).toMatch(/^m9a:/u);
    expect(Buffer.byteLength(button)).toBeLessThanOrEqual(64);
    expect(await account.callback(button)).toEqual(nav);
    expect(await f.tokens.callback(button)).toBeUndefined();
    expect(await account.callback(button.replace('m9a:', 'm9c:'))).toBeUndefined();
    expect(
      await new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '999',
        life,
        undefined,
        'account',
      ).callback(button),
    ).toBeUndefined();
    expect(
      await new SignupNavigationTokens(
        f.store,
        key,
        '12345',
        '123',
        { ...life, productEpoch: 1 },
        undefined,
        'account',
      ).callback(button),
    ).toBeUndefined();
  });
  it('isolates chat callbacks, prompt replies and claims from signup and reporting', async () => {
    const f = fixture();
    const make = (purpose: 'signup' | 'report' | 'chat', epoch = 0): SignupNavigationTokens =>
      new SignupNavigationTokens(
        f.store,
        Buffer.alloc(32, 1),
        '12345',
        '123',
        { ...life, productEpoch: epoch },
        undefined,
        purpose,
      );
    const chats = make('chat'),
      reports = make('report');
    const nav: SignupNavigation = {
      ...f.nav,
      screen: 'chat_view',
      reference: '30000000-0000-4000-8000-000000000001',
      field: '40000000-0000-4000-8000-000000000001',
    };
    const button = await chats.button(nav);
    expect(button).toMatch(/^m9c:/u);
    expect(button).not.toContain(nav.reference);
    expect(Buffer.byteLength(button)).toBeLessThanOrEqual(64);
    expect(await chats.callback(button)).toEqual(nav);
    expect(await f.tokens.callback(button)).toBeUndefined();
    expect(await reports.callback(button)).toBeUndefined();
    expect(await chats.callback(button.replace('m9c:', 'm9s:'))).toBeUndefined();
    expect(await make('chat', 1).callback(button)).toBeUndefined();
    await chats.prompt(555, { ...nav, action: 'reply', screen: 'chat_text' });
    expect((await chats.reply(555))?.actor.sessionGrantId).toBe(actor.sessionGrantId);
    expect(await f.tokens.reply(555)).toBeUndefined();
    expect(await reports.reply(555)).toBeUndefined();
    const choices = await Promise.all(
      Array.from({ length: 20 }, (_, i) => chats.claim(nav, i, button, nav)),
    );
    expect(choices.filter((c) => c.accepted)).toHaveLength(1);
    expect((await chats.claim(nav, 0, button, nav)).accepted).toBe(true);
  });
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
