import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type {
  AccountReturnGrantStore,
  AccountReturnStore,
  RateLimiterPort,
} from '@nakh/application';
import {
  TelegramAccountReturnAdapter,
  type TelegramAccountReturnNotice,
} from './account-return-adapter.js';

class Fixture {
  public life = { userId: randomUUID(), productEpoch: 0, accountVersion: 2 };
  public grant = {
    ...this.life,
    id: randomUUID(),
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 900000),
  };
  public users = { resolveAccountControlLife: vi.fn(() => Promise.resolve(this.life)) };
  public grants = {
    issue: vi.fn<AccountReturnGrantStore['issue']>(() => Promise.resolve(this.grant)),
    findForReturn: vi.fn<AccountReturnGrantStore['findForReturn']>(() =>
      Promise.resolve(this.grant),
    ),
  };
  public store = {
    return: vi.fn<AccountReturnStore['return']>(() =>
      Promise.resolve({ returned: true, accountVersion: 3, replayed: false }),
    ),
  };
  public factory = vi.fn(() => this.store);
  public limiter = {
    consume: vi.fn<RateLimiterPort['consume']>(() =>
      Promise.resolve({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
    ),
  };
  public key = Buffer.alloc(32, 144);
  public adapter = new TelegramAccountReturnAdapter(
    '12345',
    this.users,
    this.grants,
    this.factory,
    this.limiter,
    this.key,
  );
  public message(updateId = 1): Record<string, unknown> {
    return {
      update_id: updateId,
      message: {
        text: '/return',
        from: { id: 111, is_bot: false },
        chat: { id: 111, type: 'private' },
      },
    };
  }
  public callback(data: string, updateId = 2, sender = 111, bot = 12345): Record<string, unknown> {
    return {
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        data,
        from: { id: sender, is_bot: false },
        message: {
          message_id: 1,
          from: { id: bot, is_bot: true },
          chat: { id: sender, type: 'private' },
        },
      },
    };
  }
  public async prompt(): Promise<TelegramAccountReturnNotice> {
    const n = await this.adapter.handle(this.message());
    if (!n.handled) throw new Error('missing prompt');
    return n;
  }
}
describe('authenticated original-grant Telegram Return callbacks', () => {
  it('prepares short owner-bound opaque callbacks without mutation or product authority', async () => {
    const f = new Fixture(),
      n = await f.prompt();
    expect(n.notice.key).toBe('return.confirm');
    expect(n.buttons).toHaveLength(2);
    for (const b of n.buttons) {
      expect(Buffer.byteLength(b.callbackData)).toBeLessThanOrEqual(64);
      expect(b.callbackData).not.toContain(f.life.userId);
      expect(b.callbackData).not.toContain(f.grant.id);
    }
    expect(n.control?.scope).toBe('account_return');
    expect(f.store.return).not.toHaveBeenCalled();
    await f.adapter.handle(f.callback(n.buttons[1]!.callbackData));
    expect(f.store.return).not.toHaveBeenCalled();
  });
  it('retains one original command across twenty later-life retries without issuing a new grant', async () => {
    const f = new Fixture(),
      n = await f.prompt(),
      data = n.buttons[0]!.callbackData;
    f.grants.issue.mockClear();
    await f.adapter.handle(f.callback(data));
    const original = f.store.return.mock.calls[0]![0];
    f.life.productEpoch = 1;
    f.life.accountVersion = 3;
    f.store.return.mockResolvedValue({ returned: true, accountVersion: 3, replayed: true });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => f.adapter.handle(f.callback(data, i + 3))),
    );
    expect(
      results.every(
        (r) => r.handled && r.notice.key === 'return.completed' && r.control?.productEpoch === 0,
      ),
    ).toBe(true);
    expect(f.grants.issue).not.toHaveBeenCalled();
    for (const [c] of f.store.return.mock.calls)
      expect({ ...c, occurredAt: '' }).toEqual({ ...original, occurredAt: '' });
    expect(original.data).toEqual({ expectedAccountVersion: 2 });
    expect(original.actor.userId).toBe(f.life.userId);
  });
  it('rejects modified action/version/reference/MAC, wrong keys and foreign owners before native lookup', async () => {
    const f = new Fixture(),
      n = await f.prompt(),
      data = n.buttons[0]!.callbackData;
    f.grants.findForReturn.mockClear();
    for (const changed of [
      data.replace(':y:', ':n:'),
      data.replace(':2:', ':3:'),
      data.slice(0, -1) + (data.endsWith('a') ? 'b' : 'a'),
      data.replace('m8r:y:', 'm8r:y:0'),
    ])
      await expect(f.adapter.handle(f.callback(changed))).rejects.toMatchObject({ status: 400 });
    const other = new TelegramAccountReturnAdapter(
      '12345',
      f.users,
      f.grants,
      f.factory,
      f.limiter,
      Buffer.alloc(32, 145),
    );
    await expect(other.handle(f.callback(data))).rejects.toMatchObject({ status: 400 });
    f.users.resolveAccountControlLife.mockResolvedValue({ ...f.life, userId: randomUUID() });
    await expect(f.adapter.handle(f.callback(data))).rejects.toMatchObject({ status: 400 });
    expect(f.grants.findForReturn).not.toHaveBeenCalled();
    expect(f.store.return).not.toHaveBeenCalled();
  });
  it('rejects nonprivate/bot/mixed/malformed updates and never handles unrelated commands', async () => {
    const f = new Fixture(),
      n = await f.prompt(),
      data = n.buttons[0]!.callbackData;
    f.grants.findForReturn.mockClear();
    expect(await f.adapter.handle({ message: { text: '/start' } })).toEqual({ handled: false });
    for (const update of [
      f.callback(data, 2, 111, 999),
      { ...f.callback(data), message: {} },
      {
        update_id: 2,
        message: {
          text: '/return',
          from: { id: 111, is_bot: true },
          chat: { id: 111, type: 'private' },
        },
      },
      {
        update_id: 2,
        message: {
          text: '/return',
          from: { id: 111, is_bot: false },
          chat: { id: 111, type: 'group' },
        },
      },
      { ...f.message(), update_id: -1 },
    ])
      await expect(f.adapter.handle(update)).rejects.toMatchObject({ status: 400 });
    expect(f.grants.findForReturn).not.toHaveBeenCalled();
  });
  it('captures the original life and primary update identity before limiter waits', async () => {
    const f = new Fixture(),
      update = f.message();
    let release!: (r: Awaited<ReturnType<RateLimiterPort['consume']>>) => void;
    f.limiter.consume.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    const pending = f.adapter.handle(update);
    await vi.waitFor(() => expect(f.limiter.consume).toHaveBeenCalled());
    f.life.productEpoch = 1;
    update.update_id = 999;
    release({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    await pending;
    expect(f.grants.issue.mock.calls[0]![0].productEpoch).toBe(0);
    const first = f.grants.issue.mock.calls[0]![1];
    f.life.productEpoch = 0;
    await f.adapter.handle(f.message());
    expect(f.grants.issue.mock.calls[1]![1]).toBe(first);
  });
  it('fails closed on admission, missing native authority, private failures and inconsistent receipts', async () => {
    const f = new Fixture();
    f.limiter.consume.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 5 });
    expect(await f.adapter.handle(f.message())).toMatchObject({
      handled: true,
      notice: { key: 'return.rate_limited' },
      buttons: [],
    });
    expect(f.grants.issue).not.toHaveBeenCalled();
    const n = await f.prompt(),
      data = n.buttons[0]!.callbackData;
    f.grants.findForReturn.mockResolvedValueOnce(undefined);
    expect(await f.adapter.handle(f.callback(data))).toMatchObject({
      notice: { key: 'return.unavailable' },
    });
    f.store.return.mockRejectedValueOnce(
      new ApplicationError('conflict', 'private provider detail', 409),
    );
    expect(await f.adapter.handle(f.callback(data))).toMatchObject({
      notice: { key: 'return.unavailable' },
    });
    f.store.return.mockResolvedValueOnce({ returned: true, accountVersion: 4, replayed: false });
    await expect(f.adapter.handle(f.callback(data))).rejects.toMatchObject({
      status: 500,
      message: 'error.deletion.unavailable',
    });
  });
});
