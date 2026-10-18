import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramChatRuntime } from './chat-runtime.js';
describe('chat runtime activation', () => {
  it('keeps chat dormant without resolving secrets or touching native services', async () => {
    const resolveSecret = vi.fn(() => {
      throw Error('Unexpected secret access');
    });
    const runtime = createTelegramChatRuntime({
      config: { telegram: { chatEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(runtime.enabled).toBe(false);
    expect(await runtime.handle({ callback_query: { data: 'm9c:invalid' } })).toBe('unhandled');
    await expect(
      runtime.open('123', {
        kind: 'user',
        userId: 'user',
        productEpoch: 0,
        sessionGrantId: 'grant',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});
