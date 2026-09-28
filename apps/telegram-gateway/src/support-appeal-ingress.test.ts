import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramSupportAppealIngress,
  TelegramSupportAppealIngress,
} from './support-appeal-ingress.js';

describe('Telegram support/appeal activation and delivery', () => {
  it('does not resolve secrets or touch services when disabled', async () => {
    const resolveSecret = vi.fn(() => {
      throw new Error('unexpected secret access');
    });
    const ingress = createTelegramSupportAppealIngress({
      config: { telegram: { supportAppealEnabled: false } } as AppConfig,
      database: {} as NakhDatabase,
      redis: {} as ReturnType<typeof createRedisConnection>,
      resolveSecret,
    });
    expect(await ingress.handle({ message: { text: '/support' } })).toBe('unhandled');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('finishes business handling before delivering the content-free notice', async () => {
    const order: string[] = [];
    const notice = {
      handled: true as const,
      userId: 'user',
      telegramUserId: '123',
      notice: { key: 'support.sent', variables: {} },
    };
    const adapter = {
      handle: vi.fn(() => {
        order.push('business');
        return Promise.resolve(notice);
      }),
    };
    const deliver = vi.fn(() => {
      order.push('delivery');
      return Promise.resolve();
    });
    const ingress = new TelegramSupportAppealIngress(adapter, deliver);
    expect(await ingress.handle({})).toBe('notice');
    expect(order).toEqual(['business', 'delivery']);
    expect(deliver).toHaveBeenCalledWith(notice);
  });
  it('does not deliver unrelated updates and sanitizes provider failures for retry', async () => {
    const adapter = { handle: vi.fn().mockResolvedValue({ handled: false }) };
    const deliver = vi.fn().mockRejectedValue(new Error('secret provider response'));
    const ingress = new TelegramSupportAppealIngress(adapter, deliver);
    expect(await ingress.handle({})).toBe('unhandled');
    expect(deliver).not.toHaveBeenCalled();
    adapter.handle.mockResolvedValue({
      handled: true,
      userId: 'user',
      telegramUserId: '123',
      notice: { key: 'appeal.submitted', variables: {} },
    });
    await expect(ingress.handle({})).rejects.toMatchObject({
      code: 'internal_error',
      status: 500,
      message: 'error.m7.internal',
    });
  });
});
