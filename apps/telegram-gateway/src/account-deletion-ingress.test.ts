import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import {
  createTelegramAccountDeletionIngress,
  TelegramAccountDeletionIngress,
} from './account-deletion-ingress.js';
describe('limited deletion ingress activation and delivery', () => {
  it('does not touch dependencies or secrets when disabled', async () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('Unexpected secret access');
    });
    const handler = createTelegramAccountDeletionIngress({
      config: { deletion: { telegramEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(await handler.handle({ message: { text: '/delete' } })).toBe('unhandled');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('commits business work before delivery and sanitizes provider failures', async () => {
    const order: string[] = [],
      notice = {
        handled: true as const,
        userId: 'user',
        productEpoch: 0,
        telegramUserId: '111',
        control: undefined,
        callbackQueryId: undefined,
        notice: { key: 'deletion.unavailable', variables: {} },
        buttons: [],
      };
    const adapter = {
        handle: vi.fn(() => {
          order.push('business');
          return Promise.resolve(notice);
        }),
      },
      deliver = vi.fn(() => {
        order.push('delivery');
        return Promise.reject(new Error('private provider token'));
      });
    const handler = new TelegramAccountDeletionIngress(adapter, deliver);
    await expect(handler.handle({})).rejects.toMatchObject({
      message: 'error.deletion.unavailable',
      status: 500,
    });
    expect(order).toEqual(['business', 'delivery']);
  });
  it('does not deliver unrelated updates', async () => {
    const deliver = vi.fn(),
      handler = new TelegramAccountDeletionIngress(
        { handle: () => Promise.resolve({ handled: false }) },
        deliver,
      );
    expect(await handler.handle({})).toBe('unhandled');
    expect(deliver).not.toHaveBeenCalled();
  });
});
