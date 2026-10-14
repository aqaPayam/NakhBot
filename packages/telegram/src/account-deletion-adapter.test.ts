import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type {
  AccountControlSessionStore,
  AccountDeletionStore,
  RateLimiterPort,
} from '@nakh/application';
import { TelegramAccountDeletionAdapter } from './account-deletion-adapter.js';
class Fixture {
  public life = { userId: randomUUID(), productEpoch: 0, accountVersion: 1 };
  public grant = {
    userId: this.life.userId,
    productEpoch: 0,
    id: randomUUID(),
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 900000),
  };
  public users = { resolveAccountControlLife: vi.fn(() => Promise.resolve(this.life)) };
  public controls = {
    issue: vi.fn<AccountControlSessionStore['issue']>(() => Promise.resolve(this.grant)),
  };
  public proof = {
    confirmationToken: 'a'.repeat(43),
    expectedAccountVersion: 1,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  public status = {
    phase: 'shared_closure' as const,
    requestedAt: new Date().toISOString(),
    completedAt: null,
    returnDecision: 'purge_pending' as const,
  };
  public store = {
    prepare: vi.fn<AccountDeletionStore['prepare']>(() => Promise.resolve(this.proof)),
    request: vi.fn<AccountDeletionStore['request']>(() =>
      Promise.resolve({ status: this.status, accountVersion: 2, replayed: false }),
    ),
    cancel: vi.fn<AccountDeletionStore['cancel']>(() =>
      Promise.resolve({ cancelled: true, replayed: false }),
    ),
    status: vi.fn<AccountDeletionStore['status']>(() => Promise.resolve(this.status)),
  };
  public factory = vi.fn(() => this.store);
  public limiter = {
    consume: vi.fn<RateLimiterPort['consume']>(() =>
      Promise.resolve({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
    ),
  };
  public adapter = new TelegramAccountDeletionAdapter(
    '12345',
    this.users,
    this.controls,
    this.factory,
    this.limiter,
  );
  public message(text = '/delete', updateId = 1): Record<string, unknown> {
    return {
      update_id: updateId,
      message: { text, from: { id: 111, is_bot: false }, chat: { id: 111, type: 'private' } },
    };
  }
  public callback(
    data: string,
    updateId = 2,
    sender = 111,
    botId = 12345,
  ): Record<string, unknown> {
    return {
      update_id: updateId,
      callback_query: {
        id: 'callback-id',
        data,
        from: { id: sender, is_bot: false },
        message: {
          message_id: 1,
          from: { id: botId, is_bot: true },
          chat: { id: sender, type: 'private' },
        },
      },
    };
  }
}
describe('limited private Telegram account controls', () => {
  it('prepares owner-bound buttons within the 64-byte limit without exposing user or grant IDs', async () => {
    const f = new Fixture(),
      result = await f.adapter.handle(f.message());
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error('Expected handled update');
    expect(result.notice.key).toBe('deletion.confirm');
    expect(result.buttons).toHaveLength(2);
    for (const button of result.buttons) {
      expect(Buffer.byteLength(button.callbackData)).toBeLessThanOrEqual(64);
      expect(button.callbackData).not.toContain(f.life.userId);
      expect(button.callbackData).not.toContain(f.grant.id);
    }
    expect(f.store.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', userId: f.life.userId },
        expectedAccountVersion: 1,
      }),
    );
    expect(Object.isFrozen(result.control)).toBe(true);
  });
  it('uses one exact native command for repeated callback clicks and keeps cancellation distinct', async () => {
    const f = new Fixture(),
      token = f.proof.confirmationToken;
    await f.adapter.handle(f.callback('m8d:y:1:' + token, 2));
    await f.adapter.handle(f.callback('m8d:y:1:' + token, 3));
    const a = f.store.request.mock.calls[0]![0],
      b = f.store.request.mock.calls[1]![0];
    expect(a.commandId).toBe(b.commandId);
    expect(a.requestId).toBe(b.requestId);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.data).toEqual({ confirmationToken: token, expectedAccountVersion: 1 });
    expect(a.channelContext).toEqual({ channel: 'telegram', channelIdentityId: '111' });
    const cancelled = await f.adapter.handle(f.callback('m8d:n:1:' + token, 4));
    expect(cancelled).toMatchObject({ notice: { key: 'deletion.cancelled' } });
    expect(f.store.cancel.mock.calls[0]![0].commandId).not.toBe(a.commandId);
    expect(f.controls.issue.mock.calls[0]![1]).not.toBe(f.controls.issue.mock.calls[1]![1]);
  });
  it('rejects foreign bot, group, ambiguous and malformed private input before native admission', async () => {
    const f = new Fixture(),
      data = 'm8d:y:1:' + f.proof.confirmationToken;
    const inputs = [
      f.callback(data, 2, 111, 54321),
      f.callback(data, -1),
      f.callback('m8d:y:0:' + f.proof.confirmationToken),
      f.callback('m8d:y:zzzzzzz:' + f.proof.confirmationToken),
      f.callback(data + 'x'),
      { ...f.message(), update_id: NaN },
      {
        ...f.message(),
        message: {
          text: '/delete',
          from: { id: 111, is_bot: false },
          chat: { id: 222, type: 'private' },
        },
      },
      {
        ...f.message(),
        message: {
          text: '/delete',
          from: { id: 111, is_bot: false },
          chat: { id: 111, type: 'group' },
        },
      },
      { ...f.callback(data), message: { text: '/delete' } },
    ];
    for (const input of inputs)
      await expect(f.adapter.handle(input)).rejects.toMatchObject({ status: 400 });
    expect(f.controls.issue).not.toHaveBeenCalled();
    expect(f.limiter.consume).not.toHaveBeenCalled();
    expect(await f.adapter.handle(f.message('/support hello'))).toEqual({ handled: false });
  });
  it('captures the original life and account version before a limiter wait', async () => {
    const f = new Fixture();
    let release!: () => void;
    f.limiter.consume.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { allowed: true, remaining: 9, retryAfterSeconds: 0 };
    });
    const pending = f.adapter.handle(f.message());
    await vi.waitFor(() => expect(release).toBeDefined());
    f.life.productEpoch = 1;
    f.life.accountVersion = 3;
    release();
    const result = await pending;
    expect(result).toMatchObject({ productEpoch: 0 });
    expect(f.controls.issue.mock.calls[0]![0]).toEqual({ userId: f.life.userId, productEpoch: 0 });
    expect(f.store.prepare.mock.calls[0]![0].expectedAccountVersion).toBe(1);
  });
  it('retains the same origin request across lives and rejects a substituted native grant', async () => {
    const f = new Fixture();
    await f.adapter.handle(f.message());
    const origin = f.controls.issue.mock.calls[0]![1];
    f.life.productEpoch = 1;
    const result = await f.adapter.handle(f.message());
    expect(f.controls.issue.mock.calls[1]![1]).toBe(origin);
    expect(result).toMatchObject({ notice: { key: 'deletion.unavailable' }, buttons: [] });
    expect(f.store.prepare).toHaveBeenCalledTimes(1);
  });
  it('renders minimal native status and current replay outcome rather than stale progress', async () => {
    const f = new Fixture();
    f.store.status.mockResolvedValueOnce(undefined);
    expect(await f.adapter.handle(f.message('/delete_status'))).toMatchObject({
      notice: { key: 'deletion.not_requested' },
    });
    const status = {
      phase: 'completed' as const,
      requestedAt: f.status.requestedAt,
      completedAt: new Date().toISOString(),
      returnDecision: 'safety_bar' as const,
    };
    f.store.status.mockResolvedValueOnce(status);
    expect(await f.adapter.handle(f.message('/delete_status', 2))).toMatchObject({
      notice: { key: 'deletion.completed_denied' },
      buttons: [],
    });
    f.store.request.mockResolvedValueOnce({ status, accountVersion: 2, replayed: true });
    expect(
      await f.adapter.handle(f.callback('m8d:y:1:' + f.proof.confirmationToken, 3)),
    ).toMatchObject({ notice: { key: 'deletion.completed_denied' } });
  });
  it('limits before grant issuance and sanitizes private failures without a business effect', async () => {
    const f = new Fixture();
    f.limiter.consume.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    expect(await f.adapter.handle(f.message())).toMatchObject({
      control: undefined,
      notice: { key: 'deletion.rate_limited' },
      buttons: [],
    });
    expect(f.controls.issue).not.toHaveBeenCalled();
    f.store.prepare.mockRejectedValueOnce(new Error('private storage and token text'));
    await expect(f.adapter.handle(f.message('/delete', 2))).rejects.toMatchObject({
      message: 'error.deletion.unavailable',
      status: 500,
    });
    f.store.prepare.mockRejectedValueOnce(
      new ApplicationError('conflict', 'private confirmation detail', 409),
    );
    expect(await f.adapter.handle(f.message('/delete', 3))).toMatchObject({
      notice: { key: 'deletion.unavailable' },
      buttons: [],
    });
  });
});
