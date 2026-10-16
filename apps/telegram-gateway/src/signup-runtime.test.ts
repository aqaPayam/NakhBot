import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramSignupRuntime } from './signup-runtime.js';
describe('signup process activation', () => {
  it('does not resolve secrets or construct live services while disabled', async () => {
    const resolveSecret = vi.fn(() => {
      throw Error('Unexpected secret access');
    });
    const runtime = createTelegramSignupRuntime({
      config: { telegram: { signupEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(await runtime.handle({ message: { text: '/start' } })).toBe('unhandled');
    expect(runtime.openStart).toBeUndefined();
    expect(runtime.afterActivation).toBeUndefined();
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
