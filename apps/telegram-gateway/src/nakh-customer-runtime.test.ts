import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramNakhCustomerRuntime } from './nakh-customer-runtime.js';
import { createTelegramSignupRuntime } from './signup-runtime.js';

describe('Nakh inbox activation', () => {
  it('remains inert without resolving credentials or opening services', async () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('Unexpected credential read');
    });
    const runtime = createTelegramNakhCustomerRuntime({
      config: { telegram: { nakhEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(runtime.enabled).toBe(false);
    expect(await runtime.handle({ message: { text: '/nakhes' } })).toBe('unhandled');
    await expect(
      runtime.entryButton('123', {
        kind: 'user',
        userId: 'user',
        productEpoch: 0,
        sessionGrantId: 'session',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('rejects enabled signup without a composed Nakh inbox before credential access', () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('Unexpected credential read');
    });
    expect(() =>
      createTelegramSignupRuntime({
        config: { telegram: { signupEnabled: true, nakhEnabled: true } } as AppConfig,
        database: {} as NakhDatabase,
        redis: {} as ReturnType<typeof createRedisConnection>,
        resolveSecret,
      }),
    ).toThrow('Nakh inbox composition unavailable');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
