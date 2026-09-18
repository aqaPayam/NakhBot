import { describe, expect, it, vi } from 'vitest';

import type { TelegramLikedByPageRequest } from './liked-by-adapter.js';
import { TelegramLikedByPageProcessor } from './liked-by-page-processor.js';
import { TelegramLockedLikedByPresenter } from './liked-by-screen.js';

const request: TelegramLikedByPageRequest = {
  handled: true,
  kind: 'page_request',
  updateId: '42',
  userId: '10000000-0000-4000-8000-000000000000',
  telegramUserId: '12345',
  requestId: '50000000-0000-4000-8000-000000000000',
};
const cursor = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
const pageResult = {
  totalCount: 1,
  cards: [
    {
      actionToken: 'v1.lb.ponmlkjihgfedcba.abcdefghijklmnop',
      blurredPhoto: {
        deliveryUrl:
          'https://media.example.test/media/40000000-0000-4000-8000-000000000000/blurred-preview-v1.webp?token=payload.signature',
        expiresAt: '2026-10-01T00:00:00.000Z',
        variantType: 'blurred_preview' as const,
        cachePolicy: 'no-store' as const,
      },
    },
  ],
};

describe('Telegram Liked By deferred page processor', () => {
  it('queries and mints short-lived grants only when the durable request is processed', async () => {
    const page = { execute: vi.fn(() => Promise.resolve(pageResult)) };
    const processor = new TelegramLikedByPageProcessor(
      page,
      new TelegramLockedLikedByPresenter('https://media.example.test', () => 1_000),
    );
    expect(JSON.stringify(request)).not.toContain('deliveryUrl');
    const screen = await processor.execute(request);
    expect(page.execute).toHaveBeenCalledWith({
      actor: { kind: 'user', userId: request.userId },
      requestId: request.requestId,
      limit: 5,
    });
    expect(screen).toMatchObject({
      title: { key: 'liked_by.title', variables: { count: 1 } },
      cards: [{ blurredPhoto: pageResult.cards[0]!.blurredPhoto }],
    });
  });

  it('passes a bounded cursor to the authoritative reader at execution time', async () => {
    const page = { execute: vi.fn(() => Promise.resolve(pageResult)) };
    const processor = new TelegramLikedByPageProcessor(
      page,
      new TelegramLockedLikedByPresenter('https://media.example.test', () => 1_000),
    );
    await processor.execute({ ...request, callbackQueryId: 'callback-id', cursor });
    expect(page.execute).toHaveBeenCalledWith(
      expect.objectContaining({ cursor, actor: { kind: 'user', userId: request.userId } }),
    );
  });

  it('rejects malformed queued payloads before touching the read handler', async () => {
    const page = { execute: vi.fn(() => Promise.resolve(pageResult)) };
    const processor = new TelegramLikedByPageProcessor(
      page,
      new TelegramLockedLikedByPresenter('https://media.example.test', () => 1_000),
    );
    const bad = [
      { ...request, userId: 'forged' },
      { ...request, cursor },
      { ...request, extra: 'profile-data' },
      { ...request, updateId: '99999999999999999999' },
      { ...request, telegramUserId: 12345 },
      { ...request, callbackQueryId: 12, cursor },
    ];
    for (const payload of bad)
      await expect(processor.execute(payload as TelegramLikedByPageRequest)).rejects.toThrow(
        'Invalid Telegram Liked By page request.',
      );
    expect(page.execute).not.toHaveBeenCalled();
  });
});
