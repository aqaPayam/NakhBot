import { parseConfig, type AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import type { TelegramLikedByResult } from '@nakh/telegram';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { createTelegramLikedByIngress, TelegramLikedByIngress } from './liked-by-ingress.js';

const page: Extract<TelegramLikedByResult, { kind: 'page_request' }> = {
  handled: true,
  kind: 'page_request',
  updateId: '42',
  userId: '10000000-0000-4000-8000-000000000000',
  telegramUserId: '123456789',
  requestId: '20000000-0000-4000-8000-000000000000',
  cursor: 'v1.lb.abcdefghijklmnop.abcdefghijklmnop',
  callbackQueryId: 'callback-42',
};

function config(enabled: boolean): AppConfig {
  return parseConfig({
    NAKH_ENV: 'test',
    NAKH_SERVICE_NAME: 'telegram-gateway',
    NAKH_DATABASE_URL: 'postgresql://test',
    NAKH_REDIS_URL: 'redis://test',
    NAKH_TELEGRAM_BOT_TOKEN_REF: 'NAKH_TELEGRAM_BOT_TOKEN',
    NAKH_TELEGRAM_WEBHOOK_SECRET: '12345678901234567890123456789012',
    NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF: 'NAKH_TELEGRAM_ACTION_TOKEN_KEY',
    NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: String(enabled),
    NAKH_R2_ENDPOINT: 'https://r2.invalid',
    NAKH_R2_BUCKET: 'test',
    NAKH_R2_ACCESS_KEY_REF: 'fake',
    NAKH_R2_SECRET_KEY_REF: 'fake',
    NAKH_MEDIA_CDN_HOST: 'media.invalid',
    NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
  });
}

type Fixture = Readonly<{
  ingress: TelegramLikedByIngress;
  adapter: Readonly<{ handle: Mock }>;
  deliveries: Readonly<{ enqueue: Mock }>;
  callbacks: Readonly<{ acknowledgePage: Mock; deliverNotice: Mock }>;
}>;

function fixture(result: TelegramLikedByResult): Fixture {
  const adapter = { handle: vi.fn().mockResolvedValue(result) };
  const deliveries = { enqueue: vi.fn().mockResolvedValue({ deliveryId: 'id', replayed: false }) };
  const callbacks = {
    acknowledgePage: vi.fn().mockResolvedValue(undefined),
    deliverNotice: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ingress: new TelegramLikedByIngress('987654321', adapter, deliveries, callbacks),
    adapter,
    deliveries,
    callbacks,
  };
}

describe('Telegram Liked By durable ingress', () => {
  it('resolves no secrets and claims no updates while activation is disabled', async () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('must not resolve');
    });
    const ingress = createTelegramLikedByIngress({
      config: config(false),
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    await expect(ingress.handle({ message: { text: '/liked_by' } })).resolves.toBe(false);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('ignores unrelated updates without touching durable or provider state', async () => {
    const parts = fixture({ handled: false });
    await expect(parts.ingress.handle({ update_id: 1 })).resolves.toBe(false);
    expect(parts.deliveries.enqueue).not.toHaveBeenCalled();
    expect(parts.callbacks.acknowledgePage).not.toHaveBeenCalled();
  });

  it('persists the compact page request before acknowledging its callback', async () => {
    const order: string[] = [];
    const parts = fixture(page);
    parts.deliveries.enqueue.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({ deliveryId: 'id', replayed: false });
    });
    parts.callbacks.acknowledgePage.mockImplementation(() => {
      order.push('acknowledge');
      return Promise.resolve();
    });
    await expect(parts.ingress.handle({})).resolves.toBe(true);
    expect(parts.deliveries.enqueue).toHaveBeenCalledWith({
      botId: '987654321',
      updateId: page.updateId,
      userId: page.userId,
      telegramUserId: page.telegramUserId,
      requestId: page.requestId,
      cursor: page.cursor,
      callbackQueryId: page.callbackQueryId,
    });
    expect(order).toEqual(['persist', 'acknowledge']);
  });

  it('persists a command without making an ingress provider call', async () => {
    const command: Extract<TelegramLikedByResult, { kind: 'page_request' }> = {
      handled: true,
      kind: 'page_request',
      updateId: page.updateId,
      userId: page.userId,
      telegramUserId: page.telegramUserId,
      requestId: page.requestId,
    };
    const parts = fixture(command);
    await expect(parts.ingress.handle({})).resolves.toBe(true);
    expect(parts.deliveries.enqueue).toHaveBeenCalledWith({
      botId: '987654321',
      updateId: page.updateId,
      userId: page.userId,
      telegramUserId: page.telegramUserId,
      requestId: page.requestId,
    });
    expect(parts.callbacks.acknowledgePage).not.toHaveBeenCalled();
  });

  it('delivers a localized notice without creating a delivery request', async () => {
    const notice: Extract<TelegramLikedByResult, { kind: 'notice' }> = {
      handled: true,
      kind: 'notice',
      updateId: '43',
      userId: page.userId,
      telegramUserId: page.telegramUserId,
      callbackQueryId: 'callback-43',
      notice: { key: 'error.interaction.unavailable', variables: {} },
    };
    const parts = fixture(notice);
    await expect(parts.ingress.handle({})).resolves.toBe(true);
    expect(parts.callbacks.deliverNotice).toHaveBeenCalledWith(notice);
    expect(parts.deliveries.enqueue).not.toHaveBeenCalled();
  });
});
