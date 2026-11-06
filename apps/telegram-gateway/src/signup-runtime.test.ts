import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramSignupRuntime } from './signup-runtime.js';
describe('signup process activation', () => {
  it('allows callback-only payment composition but requires invoice readiness when explicitly configured', () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('credential probe reached');
    });
    const config = {
      telegram: { signupEnabled: true, starsEnabled: true, starsInvoiceCreationEnabled: false },
    } as AppConfig;
    const stars = {
      enabled: true,
      invoiceCreationEnabled: false,
      handle: () => Promise.resolve('unhandled' as const),
      invoice: () => Promise.resolve(),
    };
    const input = {
      config,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
      stars,
    };
    expect(() => createTelegramSignupRuntime(input)).toThrow('credential probe reached');
    expect(resolveSecret).toHaveBeenCalledOnce();
    resolveSecret.mockClear();
    expect(() =>
      createTelegramSignupRuntime({ ...input, stars: { ...stars, enabled: false } }),
    ).toThrow('Stars composition unavailable');
    expect(() =>
      createTelegramSignupRuntime({
        ...input,
        config: { ...config, telegram: { ...config.telegram, starsInvoiceCreationEnabled: true } },
      }),
    ).toThrow('Stars invoice composition unavailable');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
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
