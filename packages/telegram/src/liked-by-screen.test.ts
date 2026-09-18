import { describe, expect, it } from 'vitest';

import { TelegramLockedLikedByPresenter } from './liked-by-screen.js';

const action = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
const cursor = 'v1.lb.ponmlkjihgfedcba.abcdefghijklmnop';
const photo = {
  deliveryUrl:
    'https://media.example.test/media/40000000-0000-4000-8000-000000000000/blurred-preview-v1.webp?token=payload.signature',
  expiresAt: '2026-10-01T00:00:00.000Z',
  variantType: 'blurred_preview' as const,
  cachePolicy: 'no-store' as const,
};
const page = {
  totalCount: 2,
  cards: [{ actionToken: action, blurredPhoto: photo }],
  nextCursor: cursor,
};

describe('TelegramLockedLikedByPresenter', () => {
  it('prepares only localized locked cards and opaque Telegram buttons', () => {
    const screen = new TelegramLockedLikedByPresenter(
      'https://media.example.test',
      () => 1_000,
    ).present(page);
    expect(screen).toEqual({
      title: { key: 'liked_by.title', variables: { count: 2 } },
      cards: [
        {
          label: { key: 'liked_by.card.locked', variables: { position: 1 } },
          blurredPhoto: photo,
          unlock: {
            label: { key: 'liked_by.button.unlock', variables: {} },
            callbackData: action,
          },
        },
      ],
      nextPage: {
        label: { key: 'liked_by.button.next', variables: {} },
        callbackData: cursor,
      },
    });
    expect(Buffer.byteLength(screen.cards[0]!.unlock.callbackData)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(screen.nextPage!.callbackData)).toBeLessThanOrEqual(64);
    expect(JSON.stringify(screen)).not.toContain('20000000-0000-4000-8000-000000000000');
    expect(JSON.stringify(screen)).not.toContain('name');
    expect(JSON.stringify(screen)).not.toContain('city');
  });

  it('has a localized empty state without callbacks or media', () => {
    const screen = new TelegramLockedLikedByPresenter(
      'https://media.example.test',
      () => 1_000,
    ).present({ totalCount: 0, cards: [] });
    expect(screen).toEqual({
      title: { key: 'liked_by.title', variables: { count: 0 } },
      emptyState: { key: 'liked_by.empty', variables: {} },
      cards: [],
    });
  });

  it('denies a foreign media host, wrong rendition, expiry, and forged callback', () => {
    const presenter = new TelegramLockedLikedByPresenter('https://media.example.test', () => 1_000);
    expect(() =>
      presenter.present({
        ...page,
        cards: [
          {
            actionToken: action,
            blurredPhoto: {
              ...photo,
              deliveryUrl: photo.deliveryUrl.replace('media.example.test', 'attacker.test'),
            },
          },
        ],
      }),
    ).toThrow('screen input is invalid');
    expect(() =>
      presenter.present({
        ...page,
        cards: [
          {
            actionToken: action,
            blurredPhoto: {
              ...photo,
              deliveryUrl: photo.deliveryUrl.replace('blurred-preview-v1', 'thumbnail-v1'),
            },
          },
        ],
      }),
    ).toThrow('screen input is invalid');
    expect(() =>
      presenter.present({
        ...page,
        cards: [
          {
            actionToken: action,
            blurredPhoto: { ...photo, expiresAt: '1970-01-01T00:00:00.000Z' },
          },
        ],
      }),
    ).toThrow('screen input is invalid');
    expect(() => presenter.present({ ...page, nextCursor: 'raw-uuid' })).toThrow(
      'screen input is invalid',
    );
  });

  it('accepts only a fixed HTTPS media origin', () => {
    expect(() => new TelegramLockedLikedByPresenter('http://media.example.test')).toThrow();
    expect(() => new TelegramLockedLikedByPresenter('https://media.example.test/path')).toThrow();
  });
});
