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
  users: { resolveUserId: Mock };
  handler: { execute: Mock<UserSafetyContactHandler['execute']> };
  limiter: { consume: Mock };
  adapter: TelegramSupportAppealAdapter;
} => {
  const users = { resolveUserId: vi.fn().mockResolvedValue(userId) };
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
    expect(f.users.resolveUserId).not.toHaveBeenCalled();
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
    expect(f.users.resolveUserId).not.toHaveBeenCalled();
  });
  it('denies unknown users and rate-limited users before business writes', async () => {
    const f = fixture();
    f.users.resolveUserId.mockResolvedValueOnce(undefined);
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
