import { describe, expect, it } from 'vitest';

import { parseConfig, type AppConfig } from '@nakh/config';

import { createTelegramNotificationDeliveryRuntime } from './notification-delivery-runtime.js';

function config(enabled: boolean, chat = false): AppConfig {
  return parseConfig({
    NAKH_ENV: 'test',
    NAKH_SERVICE_NAME: 'worker',
    NAKH_DATABASE_URL: 'postgresql://test',
    NAKH_REDIS_URL: 'redis://test',
    NAKH_TELEGRAM_BOT_TOKEN_REF: 'NAKH_TEST_BOT_TOKEN',
    NAKH_TELEGRAM_WEBHOOK_SECRET: '12345678901234567890123456789012',
    NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED: String(enabled),
    NAKH_TELEGRAM_CHAT_ENABLED: String(chat),
    NAKH_R2_ENDPOINT: 'https://r2.invalid',
    NAKH_R2_BUCKET: 'test',
    NAKH_R2_ACCESS_KEY_REF: 'fake',
    NAKH_R2_SECRET_KEY_REF: 'fake',
    NAKH_MEDIA_CDN_HOST: 'media.invalid',
    NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
  });
}

describe('M6 Telegram notification delivery composition', () => {
  it('requires real chat composition inputs while keeping background signup disabled', () => {
    const input = {
      config: config(true, true),
      database: {} as never,
      owner: 'notification:worker-one',
      resolveSecret: (reference: string) =>
        reference === 'NAKH_TEST_BOT_TOKEN'
          ? `12345:${'x'.repeat(32)}`
          : Buffer.alloc(32, 1).toString('base64url'),
    };
    expect(input.config.telegram.signupEnabled).toBe(false);
    expect(() => createTelegramNotificationDeliveryRuntime(input)).toThrow(
      'Chat delivery composition unavailable',
    );
    const runtime = createTelegramNotificationDeliveryRuntime({ ...input, redis: {} as never });
    expect(typeof runtime?.verifyReadiness).toBe('function');
    expect(typeof runtime?.processNext).toBe('function');
    expect(() =>
      createTelegramNotificationDeliveryRuntime({
        ...input,
        redis: {} as never,
        resolveSecret: () => 'invalid',
      }),
    ).toThrow('Chat delivery composition unavailable');
  });
  it('is disabled by default and builds only after explicit activation', () => {
    const database = {} as never;
    expect(
      createTelegramNotificationDeliveryRuntime({
        config: config(false),
        database,
        owner: 'notification:worker-one',
      }),
    ).toBeUndefined();
    const runtime = createTelegramNotificationDeliveryRuntime({
      config: config(true),
      database,
      owner: 'notification:worker-one',
      resolveSecret: () => 'test-token',
    });
    expect(runtime).toBeDefined();
    expect(typeof runtime?.processNext).toBe('function');
  });
});
