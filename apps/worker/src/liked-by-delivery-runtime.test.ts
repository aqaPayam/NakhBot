import { parseConfig, type AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { describe, expect, it, vi } from 'vitest';

import { createTelegramLikedByDeliveryRuntime } from './liked-by-delivery-runtime.js';

const key = Buffer.alloc(32, 7).toString('base64url');

function config(enabled: boolean): AppConfig {
  return parseConfig({
    NAKH_ENV: 'test',
    NAKH_SERVICE_NAME: 'worker',
    NAKH_DATABASE_URL: 'postgresql://test',
    NAKH_REDIS_URL: 'redis://test',
    NAKH_QUEUE_PREFIX: 'nakh-test',
    NAKH_TELEGRAM_BOT_TOKEN_REF: 'NAKH_TELEGRAM_BOT_TOKEN',
    NAKH_TELEGRAM_WEBHOOK_SECRET: '12345678901234567890123456789012',
    NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF: 'NAKH_TELEGRAM_ACTION_TOKEN_KEY',
    NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: String(enabled),
    NAKH_R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    NAKH_R2_BUCKET: 'nakh-test',
    NAKH_R2_ACCESS_KEY_REF: 'NAKH_R2_ACCESS_KEY',
    NAKH_R2_SECRET_KEY_REF: 'NAKH_R2_SECRET_KEY',
    NAKH_MEDIA_CDN_HOST: 'media.example.test',
    NAKH_MEDIA_SIGNING_KEY_ID: 'media-v2',
    NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
    NAKH_MEDIA_AUDIENCE_KEY_ID: 'audience-v2',
    NAKH_MEDIA_AUDIENCE_KEY_REF: 'NAKH_MEDIA_AUDIENCE_KEY',
  });
}

const database = {} as NakhDatabase;
const redis = {} as ReturnType<typeof createRedisConnection>;

describe('Telegram Liked By delivery runtime composition', () => {
  it('does not resolve secrets or construct the graph while activation is disabled', () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('must not resolve');
    });
    expect(
      createTelegramLikedByDeliveryRuntime({
        config: config(false),
        database,
        redis,
        owner: 'worker-one',
        resolveSecret,
      }),
    ).toBeUndefined();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('constructs the complete graph only from referenced secrets when enabled', () => {
    const secrets: Readonly<Record<string, string>> = {
      NAKH_TELEGRAM_BOT_TOKEN: `123456789:${'a'.repeat(24)}`,
      NAKH_TELEGRAM_ACTION_TOKEN_KEY: key,
      NAKH_MEDIA_SIGNING_KEY: key,
      NAKH_MEDIA_AUDIENCE_KEY: key,
      NAKH_R2_ACCESS_KEY: 'access-key',
      NAKH_R2_SECRET_KEY: 'secret-key',
    };
    const resolveSecret = vi.fn((reference: string) => {
      const value = secrets[reference];
      if (value === undefined) throw new Error('missing test secret');
      return value;
    });
    const runtime = createTelegramLikedByDeliveryRuntime({
      config: config(true),
      database,
      redis,
      owner: 'worker-one',
      resolveSecret,
    });
    expect(runtime).toBeDefined();
    expect(typeof runtime?.processNext).toBe('function');
    expect(typeof runtime?.measureBacklog).toBe('function');
    expect(new Set(resolveSecret.mock.calls.map(([reference]) => reference))).toEqual(
      new Set(Object.keys(secrets)),
    );
  });

  it('fails startup before polling when a referenced key is malformed', () => {
    expect(() =>
      createTelegramLikedByDeliveryRuntime({
        config: config(true),
        database,
        redis,
        owner: 'worker-one',
        resolveSecret: (reference) =>
          reference === 'NAKH_TELEGRAM_BOT_TOKEN'
            ? `123456789:${'a'.repeat(24)}`
            : 'not-base64url!',
      }),
    ).toThrow('Invalid delivery secret key');
  });
});
