import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type { UserSafetyContactHandler } from '@nakh/application';
import { TelegramSupportAppealAdapter } from './support-appeal-adapter.js';

const update = (
  text = '/support private text',
  id = 42,
): {
  update_id: number;
  actor: { userId: string };
  message: {
    text: string;
    from: { id: number; is_bot: boolean };
    chat: { id: number; type: string };
  };
} => {
  return {
    update_id: id,
    actor: { userId: 'forged' },
    message: { text, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' } },
  };
};
const fixture = (
  botId = '987',
  userId: string = randomUUID(),
): {
  userId: string;
  users: { resolveProductLife: Mock };
  handler: { execute: Mock<UserSafetyContactHandler['execute']> };
  limiter: { consume: Mock };
  adapter: TelegramSupportAppealAdapter;
} => {
  const users = { resolveProductLife: vi.fn().mockResolvedValue({ userId, productEpoch: 0 }) };
  const handler = {
    execute: vi
      .fn<UserSafetyContactHandler['execute']>()
      .mockResolvedValue({ key: 'support.sent', variables: {} }),
  };
  const limiter = { consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) };
  return {
    userId,
    users,
    handler,
    limiter,
    adapter: new TelegramSupportAppealAdapter(botId, users, handler, limiter),
  };
};
describe('Telegram support and appeal ingress boundary', () => {
  it('routes payment support through the same native life, rate limit and replay identity as ordinary support', async () => {
    const f = fixture();
    f.users.resolveProductLife.mockResolvedValue({ userId: f.userId, productEpoch: 3 });
    const notice = await f.adapter.handle(update('/paysupport My purchase is missing'));
    expect(notice).toMatchObject({
      handled: true,
      productEpoch: 3,
      notice: { key: 'support.sent' },
    });
    expect(JSON.stringify(notice)).not.toContain('My purchase');
    const command = f.handler.execute.mock.calls[0]![0];
    expect(command).toMatchObject({
      userId: f.userId,
      productEpoch: 3,
      kind: 'support',
      text: 'My purchase is missing',
    });
    await f.adapter.handle(update('/support My purchase is missing'));
    expect(f.handler.execute.mock.calls[1]![0]).toEqual(command);
    expect(f.limiter.consume).toHaveBeenCalledWith({
      scope: 'telegram_support_appeal',
      subject: f.userId,
      limit: 10,
      windowSeconds: 60,
    });
    await f.adapter.handle(update('/paysupport', 43));
    expect(f.handler.execute.mock.calls[2]![0]).toMatchObject({ kind: 'support', text: '' });
  });
  it('keeps payment support private and rejects unknown or throttled callers before writes', async () => {
    const f = fixture();
    const group = update('/paysupport private charge');
    group.message.chat.type = 'group';
    await expect(f.adapter.handle(group)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.users.resolveProductLife).not.toHaveBeenCalled();
    f.users.resolveProductLife.mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update('/paysupport private charge'))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    f.limiter.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 10 });
    expect(await f.adapter.handle(update('/paysupport private charge'))).toMatchObject({
      notice: { key: 'error.m7.rate_limited' },
    });
    expect(f.handler.execute).not.toHaveBeenCalled();
    expect(await f.adapter.handle(update('/paysupporting private charge'))).toEqual({
      handled: false,
    });
  });

  it('collects a bounded private rating through the existing support workflow only for admitted testers', async () => {
    const f = fixture(),
      allowed = vi.fn().mockResolvedValue(true);
    const adapter = new TelegramSupportAppealAdapter('987', f.users, f.handler, f.limiter, allowed);
    f.handler.execute.mockResolvedValue({ key: 'support.sent', variables: {} });
    expect(await adapter.handle(update('/feedback 5 Clear and useful'))).toMatchObject({
      notice: { key: 'trial.feedback.sent' },
    });
    expect(f.handler.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'support',
        text: '[Private trial feedback]\nRating: 5/5\nClear and useful',
        productEpoch: 0,
      }),
    );
    const command = f.handler.execute.mock.calls[0]![0];
    await adapter.handle(update('/feedback 5 Clear and useful'));
    expect(f.handler.execute.mock.calls[1]![0]).toEqual(command);
    f.handler.execute.mockClear();
    for (const text of ['/feedback', '/feedback 0 bad', '/feedback 6 bad', '/feedback 5.5 bad'])
      expect(await adapter.handle(update(text))).toMatchObject({
        notice: { key: 'trial.feedback.prompt' },
      });
    expect(f.handler.execute).not.toHaveBeenCalled();
    allowed.mockResolvedValue(false);
    expect(await adapter.handle(update('/feedback 5 test'))).toMatchObject({
      notice: { key: 'error.m7.unavailable' },
    });
    expect(f.handler.execute).not.toHaveBeenCalled();
  });
  it('freezes native life before a limiter wait and separates later-life replay identities', async () => {
    const f = fixture();
    let release!: () => void, observed!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    f.limiter.consume.mockImplementationOnce(async () => {
      observed();
      await waiting;
      return { allowed: true, retryAfterSeconds: 0 };
    });
    const pending = f.adapter.handle(update());
    await started;
    f.users.resolveProductLife.mockResolvedValue({ userId: f.userId, productEpoch: 1 });
    release();
    expect(await pending).toMatchObject({ handled: true, productEpoch: 0 });
    expect(f.handler.execute.mock.calls[0]?.[0]).toMatchObject({
      userId: f.userId,
      productEpoch: 0,
    });
    await f.adapter.handle(update());
    expect(f.handler.execute.mock.calls[1]?.[0]).toMatchObject({ productEpoch: 1 });
    expect(f.handler.execute.mock.calls[1]?.[0].commandId).not.toBe(
      f.handler.execute.mock.calls[0]?.[0].commandId,
    );
  });
  it('ignores provider-supplied epoch fields and forwards only the captured native life', async () => {
    const f = fixture();
    await f.adapter.handle({
      ...update(),
      productEpoch: 99,
      actor: { userId: 'forged', productEpoch: 99 },
    });
    expect(f.handler.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: f.userId, productEpoch: 0 }),
    );
  });
  it('uses only resolved identity and stable replay IDs scoped to bot, user and update', async () => {
    const f = fixture();
    const first = await f.adapter.handle(update());
    await f.adapter.handle(update());
    expect(f.handler.execute.mock.calls[0]).toEqual(f.handler.execute.mock.calls[1]);
    expect(f.handler.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: f.userId,
        kind: 'support',
        text: 'private text',
      }),
    );
    expect(f.handler.execute.mock.calls[0]?.[0].commandId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(first)).not.toContain('private text');
    await f.adapter.handle(update('/support changed text'));
    expect(f.handler.execute.mock.calls[2]?.[0]).toMatchObject({
      commandId: f.handler.execute.mock.calls[0]?.[0].commandId,
    });
    await f.adapter.handle(update('/appeal explanation', 43));
    const otherBot = fixture('988', f.userId);
    const otherUser = fixture('987');
    await otherBot.adapter.handle(update());
    await otherUser.adapter.handle(update());
    const ids = [
      f.handler.execute.mock.calls[0]?.[0].commandId,
      f.handler.execute.mock.calls[3]?.[0].commandId,
      otherBot.handler.execute.mock.calls[0]?.[0].commandId,
      otherUser.handler.execute.mock.calls[0]?.[0].commandId,
    ];
    expect(new Set(ids).size).toBe(4);
  });
  it('ignores unrelated commands and edited messages without resolving identity', async () => {
    const f = fixture();
    for (const value of [
      update('/supporting text'),
      update('/start'),
      { edited_message: update().message },
      {},
    ])
      expect(await f.adapter.handle(value)).toEqual({ handled: false });
    expect(f.users.resolveProductLife).not.toHaveBeenCalled();
  });
  it('rejects group, bot, forged chat and unsafe numeric identities before resolution', async () => {
    const f = fixture();
    const valid = update();
    for (const value of [
      { ...valid, update_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, message: { ...valid.message, chat: { id: 123, type: 'group' } } },
      { ...valid, message: { ...valid.message, chat: { id: 456, type: 'private' } } },
      { ...valid, message: { ...valid.message, from: { id: 123, is_bot: true } } },
      {
        ...valid,
        message: { ...valid.message, from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false } },
      },
    ])
      await expect(f.adapter.handle(value)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.users.resolveProductLife).not.toHaveBeenCalled();
  });
  it('denies unknown users and rate-limited users before business writes', async () => {
    const f = fixture();
    f.users.resolveProductLife.mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update())).rejects.toMatchObject({ code: 'unauthorized' });
    f.limiter.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 12 });
    expect(await f.adapter.handle(update())).toMatchObject({
      notice: { key: 'error.m7.rate_limited', variables: {} },
    });
    expect(f.handler.execute).not.toHaveBeenCalled();
  });
  it('localizes expected failures and sanitizes retryable failures without leaking text', async () => {
    const f = fixture();
    f.handler.execute.mockRejectedValueOnce(
      new ApplicationError('support_unanswered_limit', 'private text', 409),
    );
    expect(await f.adapter.handle(update())).toMatchObject({
      notice: { key: 'error.support.unanswered_limit', variables: {} },
    });
    f.handler.execute.mockRejectedValueOnce(new Error('private text'));
    await expect(f.adapter.handle(update())).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
      status: 500,
    });
  });
});
