import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramAccountRuntime } from './account-runtime.js';
import { createTelegramSignupRuntime } from './signup-runtime.js';

describe('account menu activation', () => {
  it('keeps the account menu inert without reading secrets or services', async () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('Unexpected secret');
    });
    const runtime = createTelegramAccountRuntime({
      config: { telegram: { accountMenuEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      financialDatabase: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(runtime.enabled).toBe(false);
    expect(await runtime.handle({ message: { text: '/credits' } })).toBe('unhandled');
    await expect(
      runtime.open('123', {
        kind: 'user',
        userId: 'user',
        productEpoch: 0,
        sessionGrantId: 'grant',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('rejects an enabled menu missing its host adapter before accessing secrets', () => {
    const resolveSecret = vi.fn(() => 'unused');
    expect(() =>
      createTelegramSignupRuntime({
        config: { telegram: { signupEnabled: true, accountMenuEnabled: true } } as AppConfig,
        database: {} as NakhDatabase,
        redis: {} as ReturnType<typeof createRedisConnection>,
        resolveSecret,
      }),
    ).toThrow('Account menu composition unavailable');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
