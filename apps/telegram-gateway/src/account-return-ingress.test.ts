import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import {
  TelegramAccountReturnIngress,
  createTelegramAccountReturnIngress,
} from './account-return-ingress.js';
describe('Telegram Return activation and safe failure handling', () => {
  it('keeps the disabled ingress inert without loading secrets or touching providers', async () => {
    const resolveSecret = vi.fn();
    const ingress = createTelegramAccountReturnIngress({
      config: { deletion: { returnTelegramEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(await ingress.handle({})).toBe('unhandled');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected adapter failures without private causes or delivery', async () => {
    const deliver = vi.fn(),
      ingress = new TelegramAccountReturnIngress(
        { handle: () => Promise.reject(new Error('private token-bearing provider URL')) },
        deliver,
      );
    await expect(ingress.handle({})).rejects.toMatchObject({
      status: 500,
      message: 'error.deletion.unavailable',
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
