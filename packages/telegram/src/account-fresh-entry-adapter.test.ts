import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type { AccountControlSessionStore, RateLimiterPort } from '@nakh/application';
import {
  TelegramFreshEntryAdapter,
  type TelegramFreshEntryNotice,
} from './account-fresh-entry-adapter.js';
class Fixture {
  public life = { userId: randomUUID(), productEpoch: 1 };
  public grant = {
    ...this.life,
    id: randomUUID(),
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 900000),
  };
  public users = {
    resolveProductLife: vi.fn(() => Promise.resolve(this.life as typeof this.life | undefined)),
  };
  public grants = {
    issue: vi.fn<AccountControlSessionStore['issue']>(() => Promise.resolve(this.grant)),
    current: vi.fn<AccountControlSessionStore['current']>(() => Promise.resolve(this.grant)),
  };
  public activate = vi.fn(() => Promise.resolve());
  public factory = vi.fn(() => ({ activate: this.activate }));
  public limiter = {
    consume: vi.fn<RateLimiterPort['consume']>(() =>
      Promise.resolve({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
    ),
  };
  public adapter = new TelegramFreshEntryAdapter(
    '12345',
    this.users,
    this.grants,
    this.factory,
    this.limiter,
    Buffer.alloc(32, 7),
  );
  public message(id = 1): Record<string, unknown> {
    return {
      update_id: id,
      message: {
        text: '/start',
        from: { id: 111, is_bot: false },
        chat: { id: 111, type: 'private' },
      },
    };
  }
  public callback(data: string, id = 2, sender = 111, bot = 12345): Record<string, unknown> {
    return {
      update_id: id,
      callback_query: {
        id: `cb-${id}`,
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
  public async prompt(): Promise<TelegramFreshEntryNotice> {
    const n = await this.adapter.handle(this.message());
    if (!n.handled) throw Error('missing prompt');
    return n;
  }
}
describe('authenticated fresh primary entry confirmation', () => {
  it('only prepares a short opaque challenge and treats Not now as presentation', async () => {
    const f = new Fixture(),
      n = await f.prompt();
    expect(n.notice.key).toBe('entry.confirm');
    expect(n.control?.scope).toBe('account_control');
    for (const b of n.buttons) {
      expect(Buffer.byteLength(b.callbackData)).toBeLessThanOrEqual(64);
      expect(b.callbackData).not.toContain(f.life.userId);
      expect(b.callbackData).not.toContain(f.grant.id);
    }
    expect(f.activate).not.toHaveBeenCalled();
    expect(await f.adapter.handle(f.callback(n.buttons[1]!.callbackData))).toMatchObject({
      notice: { key: 'entry.dismissed' },
    });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it('preserves initial registration and deleted-account routing without issuing a grant', async () => {
    const f = new Fixture();
    f.users.resolveProductLife.mockResolvedValue({ ...f.life, productEpoch: 0 });
    expect(await f.adapter.handle(f.message())).toEqual({ handled: false });
    f.users.resolveProductLife.mockResolvedValue(undefined);
    expect(await f.adapter.handle(f.message())).toEqual({ handled: false });
    expect(f.grants.issue).not.toHaveBeenCalled();
  });
  it('uses the same captured current-life grant across twenty explicit retries without reissuing', async () => {
    const f = new Fixture(),
      n = await f.prompt();
    f.grants.issue.mockClear();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.adapter.handle(f.callback(n.buttons[0]!.callbackData, i + 3)),
      ),
    );
    expect(results.every((n) => n.handled && n.notice.key === 'entry.completed')).toBe(true);
    expect(f.grants.issue).not.toHaveBeenCalled();
    expect(f.activate).toHaveBeenCalledTimes(20);
    for (const [actor] of f.factory.mock.calls as unknown as [
      { productEpoch: number; controlGrantId: string },
    ][]) {
      expect(actor).toMatchObject({ productEpoch: 1, controlGrantId: f.grant.id });
      expect(Object.isFrozen(actor)).toBe(true);
    }
  });
  it('rejects foreign users, bots, tampered and cross-purpose callbacks before activation', async () => {
    const f = new Fixture(),
      n = await f.prompt(),
      data = n.buttons[0]!.callbackData;
    for (const update of [
      f.callback(data, 2, 111, 54321),
      f.callback(data.replace('m8e:y:', 'm8e:n:')),
      f.callback(data.slice(0, -1) + (data.endsWith('A') ? 'B' : 'A')),
    ])
      await expect(f.adapter.handle(update)).rejects.toMatchObject({ status: 400 });
    f.users.resolveProductLife.mockResolvedValue({ ...f.life, userId: randomUUID() });
    await expect(f.adapter.handle(f.callback(data))).rejects.toMatchObject({ status: 400 });
    expect(await f.adapter.handle(f.callback(data.replace('m8e:', 'm8r:')))).toEqual({
      handled: false,
    });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it('never rebinds an old grant or origin request to a replacement life', async () => {
    const f = new Fixture();
    await f.prompt();
    const original = f.grants.issue.mock.calls[0]![1];
    f.life.productEpoch = 2;
    const n = await f.adapter.handle(f.message());
    expect(n).toMatchObject({ notice: { key: 'entry.unavailable' } });
    expect(f.grants.issue.mock.calls[1]![1]).toBe(original);
    expect(f.activate).not.toHaveBeenCalled();
  });
  it('freezes resolved life before admission waits and denies rate limits before grant lookup', async () => {
    const f = new Fixture();
    f.limiter.consume.mockImplementationOnce(() => {
      f.life.productEpoch = 2;
      return Promise.resolve({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
    });
    const n = await f.prompt();
    expect(n.productEpoch).toBe(1);
    expect(f.grants.issue.mock.calls[0]![0].productEpoch).toBe(1);
    f.grants.issue.mockClear();
    f.limiter.consume.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    expect(await f.adapter.handle(f.message(3))).toMatchObject({
      notice: { key: 'entry.rate_limited' },
      buttons: [],
    });
    expect(f.grants.issue).not.toHaveBeenCalled();
  });
  it('does not acknowledge activation failure as completed and sanitizes provider details', async () => {
    const f = new Fixture(),
      n = await f.prompt();
    f.activate.mockRejectedValueOnce(new Error('private provider details'));
    await expect(f.adapter.handle(f.callback(n.buttons[0]!.callbackData))).rejects.toMatchObject({
      status: 500,
      message: 'error.deletion.unavailable',
    });
    f.activate.mockRejectedValueOnce(new ApplicationError('conflict', 'private', 409));
    expect(await f.adapter.handle(f.callback(n.buttons[0]!.callbackData))).toMatchObject({
      notice: { key: 'entry.unavailable' },
    });
  });
});
