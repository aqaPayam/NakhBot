import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramProfileRuntime } from './profile-runtime.js';
import { createTelegramSignupRuntime } from './signup-runtime.js';

describe('owned profile editor activation', () => {
  it('does not resolve secrets, databases or cache while disabled', async () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('Unexpected secret access');
    });
    const runtime = createTelegramProfileRuntime({
      config: { telegram: { accountMenuEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(runtime.enabled).toBe(false);
    expect(await runtime.handle({ message: { text: '/edit_profile' } })).toBe('unhandled');
    expect(await runtime.handle({ message: { text: '/filters' } })).toBe('unhandled');
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
  it('requires the editor when the full account menu is enabled before reading secrets', () => {
    const resolveSecret = vi.fn(() => 'unused');
    expect(() =>
      createTelegramSignupRuntime({
        config: { telegram: { signupEnabled: true, accountMenuEnabled: true } } as AppConfig,
        database: {} as NakhDatabase,
        redis: {} as ReturnType<typeof createRedisConnection>,
        resolveSecret,
        account: {
          enabled: true,
          handle: () => Promise.resolve('unhandled'),
          open: () => Promise.resolve(),
        },
      }),
    ).toThrow('Profile editor composition unavailable');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
