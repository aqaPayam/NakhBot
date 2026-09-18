import { describe, expect, it, vi, type Mock } from 'vitest';

import { TelegramLikedByAdapter } from './liked-by-adapter.js';

const viewerId = '10000000-0000-4000-8000-000000000000';
const likeId = '20000000-0000-4000-8000-000000000000';
const cursor = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
const action = 'v1.lb.ponmlkjihgfedcba.abcdefghijklmnop';

function command(chatType = 'private'): unknown {
  return {
    update_id: 42,
    message: {
      from: { id: 12345 },
      chat: { id: 12345, type: chatType },
      text: '/liked_by',
    },
  };
}

function callback(data: string, chatId = 12345): unknown {
  return {
    update_id: 43,
    callback_query: {
      id: 'callback-id',
      from: { id: 12345 },
      message: { chat: { id: chatId, type: 'private' } },
      data,
    },
  };
}

type Fixture = Readonly<{
  adapter: TelegramLikedByAdapter;
  resolver: Readonly<{ resolveUserId: Mock }>;
  references: Readonly<{ resolveCursor: Mock; resolveAction: Mock }>;
  limiter: Readonly<{ consume: Mock }>;
}>;

function fixture(): Fixture {
  const resolver = { resolveUserId: vi.fn(() => Promise.resolve(viewerId)) };
  const references = {
    resolveCursor: vi.fn(() => Promise.resolve(undefined)),
    resolveAction: vi.fn(() => Promise.resolve(undefined as string | undefined)),
  };
  const limiter = {
    consume: vi.fn(() => Promise.resolve({ allowed: true, remaining: 19, retryAfterSeconds: 0 })),
  };
  const adapter = new TelegramLikedByAdapter(
    resolver,
    references,
    limiter,
    () => '50000000-0000-4000-8000-000000000000',
  );
  return { adapter, resolver, references, limiter };
}

describe('Telegram Liked By ingress', () => {
  it('resolves a private-chat command to a minimal durable request, without querying or minting grants', async () => {
    const parts = fixture();
    const result = await parts.adapter.handle(command());
    expect(parts.resolver.resolveUserId).toHaveBeenCalledWith('12345');
    expect(parts.limiter.consume).toHaveBeenCalledWith({
      scope: 'telegram_liked_by',
      subject: viewerId,
      limit: 20,
      windowSeconds: 60,
    });
    expect(result).toEqual({
      handled: true,
      kind: 'page_request',
      updateId: '42',
      userId: viewerId,
      telegramUserId: '12345',
      requestId: '50000000-0000-4000-8000-000000000000',
    });
    expect(JSON.stringify(result)).not.toContain(likeId);
    expect(JSON.stringify(result)).not.toContain('deliveryUrl');
  });

  it('accepts only the receiver-bound cursor for pagination', async () => {
    const parts = fixture();
    parts.references.resolveCursor.mockResolvedValue({ createdAt: new Date(), likeId });
    const result = await parts.adapter.handle(callback(cursor));
    expect(parts.references.resolveCursor).toHaveBeenCalledWith(cursor, viewerId);
    expect(parts.references.resolveAction).not.toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      kind: 'page_request',
      callbackQueryId: 'callback-id',
      cursor,
      updateId: '43',
      userId: viewerId,
      telegramUserId: '12345',
      requestId: '50000000-0000-4000-8000-000000000000',
    });
  });

  it('does not interpret an M4 unlock action as an M3 page request', async () => {
    const parts = fixture();
    parts.references.resolveAction.mockResolvedValue(likeId);
    const result = await parts.adapter.handle(callback(action));
    expect(result).toMatchObject({
      handled: true,
      kind: 'notice',
      callbackQueryId: 'callback-id',
      notice: { key: 'error.interaction.unavailable', variables: {} },
    });
    expect(JSON.stringify(result)).not.toContain(likeId);
  });

  it('answers a forged or expired reference with a stale-action notice', async () => {
    const parts = fixture();
    expect(await parts.adapter.handle(callback('v1.lb.forged'))).toMatchObject({
      handled: true,
      kind: 'notice',
      notice: { key: 'error.interaction.cursor_invalid', variables: {} },
    });
    expect(parts.references.resolveCursor).not.toHaveBeenCalled();
  });

  it('ignores unrelated updates and refuses public or foreign-chat requests', async () => {
    const parts = fixture();
    expect(await parts.adapter.handle({ update_id: 44, message: { text: '/explore' } })).toEqual({
      handled: false,
    });
    await expect(parts.adapter.handle(command('group'))).rejects.toMatchObject({ status: 400 });
    await expect(parts.adapter.handle(callback(cursor, 999))).rejects.toMatchObject({
      status: 400,
    });
    expect(parts.resolver.resolveUserId).not.toHaveBeenCalled();
  });

  it('rate-limits before Redis cursor lookup or a delivery request', async () => {
    const parts = fixture();
    parts.limiter.consume.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 10,
    });
    await expect(parts.adapter.handle(callback(cursor))).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect(parts.references.resolveCursor).not.toHaveBeenCalled();
  });
});
