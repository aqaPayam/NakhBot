import { describe, expect, it, vi, type Mock } from 'vitest';

import { TelegramLikedByAdapter } from './liked-by-adapter.js';
import { TelegramLockedLikedByPresenter } from './liked-by-screen.js';

const viewerId = '10000000-0000-4000-8000-000000000000';
const likeId = '20000000-0000-4000-8000-000000000000';
const cursor = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
const action = 'v1.lb.ponmlkjihgfedcba.abcdefghijklmnop';
const photo = {
  deliveryUrl:
    'https://media.example.test/media/40000000-0000-4000-8000-000000000000/blurred-preview-v1.webp?token=payload.signature',
  expiresAt: '2026-10-01T00:00:00.000Z',
  variantType: 'blurred_preview' as const,
  cachePolicy: 'no-store' as const,
};

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
  page: Readonly<{ execute: Mock }>;
  references: Readonly<{ resolveCursor: Mock; resolveAction: Mock }>;
  limiter: Readonly<{ consume: Mock }>;
}>;

function fixture(): Fixture {
  const resolver = { resolveUserId: vi.fn(() => Promise.resolve(viewerId)) };
  const page = {
    execute: vi.fn(() =>
      Promise.resolve({
        totalCount: 1,
        cards: [{ actionToken: action, blurredPhoto: photo }],
        nextCursor: cursor,
      }),
    ),
  };
  const references = {
    resolveCursor: vi.fn(() => Promise.resolve(undefined)),
    resolveAction: vi.fn(() => Promise.resolve(undefined as string | undefined)),
  };
  const limiter = {
    consume: vi.fn(() => Promise.resolve({ allowed: true, remaining: 19, retryAfterSeconds: 0 })),
  };
  const adapter = new TelegramLikedByAdapter(
    resolver,
    page,
    references,
    new TelegramLockedLikedByPresenter('https://media.example.test', () => 1_000),
    limiter,
    () => '50000000-0000-4000-8000-000000000000',
  );
  return { adapter, resolver, page, references, limiter };
}

describe('Telegram Liked By ingress', () => {
  it('resolves a private-chat command to one bounded, authorized page query', async () => {
    const parts = fixture();
    const result = await parts.adapter.handle(command());
    expect(parts.resolver.resolveUserId).toHaveBeenCalledWith('12345');
    expect(parts.limiter.consume).toHaveBeenCalledWith({
      scope: 'telegram_liked_by',
      subject: viewerId,
      limit: 20,
      windowSeconds: 60,
    });
    expect(parts.page.execute).toHaveBeenCalledWith({
      actor: { kind: 'user', userId: viewerId },
      requestId: '50000000-0000-4000-8000-000000000000',
      limit: 5,
    });
    expect(result).toMatchObject({
      handled: true,
      kind: 'page',
      updateId: '42',
      userId: viewerId,
      telegramUserId: '12345',
      screen: { title: { key: 'liked_by.title', variables: { count: 1 } } },
    });
    expect(JSON.stringify(result)).not.toContain(likeId);
  });

  it('accepts only the receiver-bound cursor for pagination', async () => {
    const parts = fixture();
    parts.references.resolveCursor.mockResolvedValue({ createdAt: new Date(), likeId });
    const result = await parts.adapter.handle(callback(cursor));
    expect(parts.references.resolveCursor).toHaveBeenCalledWith(cursor, viewerId);
    expect(parts.references.resolveAction).not.toHaveBeenCalled();
    expect(parts.page.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: 'user', userId: viewerId }, cursor }),
    );
    expect(result).toMatchObject({
      handled: true,
      kind: 'page',
      callbackQueryId: 'callback-id',
      updateId: '43',
    });
  });

  it('does not interpret an M4 unlock action as an M3 page request', async () => {
    const parts = fixture();
    parts.references.resolveAction.mockResolvedValue(likeId);
    const result = await parts.adapter.handle(callback(action));
    expect(parts.page.execute).not.toHaveBeenCalled();
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
    expect(parts.page.execute).not.toHaveBeenCalled();
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

  it('rate-limits before Redis cursor lookup or a database read', async () => {
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
    expect(parts.page.execute).not.toHaveBeenCalled();
  });
});
