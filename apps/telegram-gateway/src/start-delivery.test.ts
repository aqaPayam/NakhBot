import { routeStart, type IdentityContextSnapshot } from '@nakh/application';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import { describe, expect, it, vi } from 'vitest';
import { createTelegramStartDelivery, TelegramStartDelivery } from './start-delivery.js';

function context(): IdentityContextSnapshot {
  return {
    userId: 'user',
    accountState: 'guest',
    profileCompletion: null,
    visibilityEnabled: true,
    uiLocale: 'en',
    guestPreviewCount: 0,
    guestPreviewLimit: 10,
    entryRoute: 'guest',
    accountVersion: 1,
    settingsVersion: 1,
  };
}
function update(): Record<string, unknown> {
  return {
    update_id: 7,
    message: {
      text: '/start',
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
    },
  };
}
function fixture(): {
  state: {
    life: { userId: string; productEpoch: number; accountVersion: number };
    context: IdentityContextSnapshot;
  };
  read: ReturnType<typeof vi.fn>;
  adapter: { handle: ReturnType<typeof vi.fn> };
  render: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  port: TelegramStartDelivery;
} {
  const state = {
    life: { userId: 'user', productEpoch: 0, accountVersion: 1 },
    context: context(),
  };
  const read = vi.fn().mockResolvedValue(state),
    adapter = {
      handle: vi.fn().mockResolvedValue({
        handled: true,
        userId: 'user',
        replayed: true,
        view: routeStart('main'),
      }),
    },
    render = vi.fn().mockResolvedValue('Welcome'),
    send = vi.fn().mockResolvedValue(undefined);
  return {
    state,
    read,
    adapter,
    render,
    send,
    port: new TelegramStartDelivery(adapter, read, render, send),
  };
}

describe('private start status delivery', () => {
  it('stays disabled without resolving credentials or opening services', () => {
    const adapter = { handle: vi.fn() },
      resolveSecret = vi.fn();
    expect(
      createTelegramStartDelivery({
        config: { telegram: { startDeliveryEnabled: false } } as AppConfig,
        database: {} as NakhDatabase,
        adapter,
        resolveSecret,
      }),
    ).toBe(adapter);
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('uses the current route and language instead of a cached registration view', async () => {
    const f = fixture();
    f.state.context = { ...f.state.context, uiLocale: 'fa' };
    expect(await f.port.handle(update())).toMatchObject({
      replayed: true,
      view: routeStart('guest'),
    });
    expect(f.render).toHaveBeenCalledWith(f.state.context);
    expect(f.send).toHaveBeenCalledExactlyOnceWith('123', 'Welcome');
  });
  it('allows initial registration but refuses a new life appearing during registration', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(undefined);
    await f.port.handle(update());
    expect(f.send).toHaveBeenCalledOnce();
    f.send.mockClear();
    f.read.mockResolvedValueOnce(undefined);
    f.state.life.productEpoch = 1;
    await expect(f.port.handle(update())).rejects.toMatchObject({ status: 401 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects forged, group and mixed-origin updates before registration or state reads', async () => {
    const invalid = [
      { update_id: -1 },
      { update_id: Number.MAX_SAFE_INTEGER + 1 },
      { callback_query: {} },
      {
        message: {
          text: '/start',
          from: { id: 123, is_bot: true },
          chat: { id: 123, type: 'private' },
        },
      },
      {
        message: {
          text: '/start',
          from: { id: 123, is_bot: false },
          chat: { id: 123, type: 'group' },
        },
      },
      {
        message: {
          text: '/start',
          from: { id: 123, is_bot: false },
          chat: { id: 456, type: 'private' },
        },
      },
    ];
    for (const fields of invalid) {
      const f = fixture();
      await expect(f.port.handle({ ...update(), ...fields })).rejects.toMatchObject({
        status: 400,
      });
      expect(f.adapter.handle).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('does not claim unrelated commands or edited starts', async () => {
    const f = fixture();
    for (const value of [
      {},
      { edited_message: update().message },
      { message: { text: '/startle' } },
      { message: { text: '/support' } },
    ])
      expect(await f.port.handle(value)).toEqual({ handled: false });
    expect(f.adapter.handle).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('blocks state or language changes while waiting for catalog rendering', async () => {
    const variants = [
      undefined,
      { life: { userId: 'other', productEpoch: 0, accountVersion: 1 }, context: context() },
      { life: { userId: 'user', productEpoch: 1, accountVersion: 1 }, context: context() },
      { life: { userId: 'user', productEpoch: 0, accountVersion: 2 }, context: context() },
      ...[
        { uiLocale: 'fa' },
        { settingsVersion: 2 },
        { accountVersion: 2 },
        { entryRoute: 'ban_appeal' as const },
      ].map((change) => ({
        life: { userId: 'user', productEpoch: 0, accountVersion: 1 },
        context: { ...context(), ...change },
      })),
    ];
    for (const next of variants) {
      const f = fixture();
      f.read
        .mockResolvedValueOnce(f.state)
        .mockResolvedValueOnce(f.state)
        .mockResolvedValueOnce(next);
      await expect(f.port.handle(update())).rejects.toMatchObject({ status: 401 });
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('refuses foreign registration receipts and inconsistent snapshots', async () => {
    for (const state of [
      { ...fixture().state, life: { userId: 'foreign', productEpoch: 0, accountVersion: 1 } },
      { ...fixture().state, context: { ...context(), accountVersion: 2 } },
      undefined,
    ]) {
      const f = fixture();
      f.read.mockResolvedValue(state);
      await expect(f.port.handle(update())).rejects.toMatchObject({ status: 401 });
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('sanitizes provider failures and permits retry delivery using the same business update', async () => {
    const f = fixture();
    const secret = 'private-provider-token';
    f.send.mockRejectedValueOnce(new Error(secret));
    await expect(f.port.handle(update())).rejects.toMatchObject({
      status: 500,
      message: 'error.identity.user_context_invalid',
    });
    await f.port.handle(update());
    expect(f.adapter.handle.mock.calls).toEqual([[update()], [update()]]);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
});
