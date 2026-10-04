import { describe, expect, it, vi } from 'vitest';
import { TelegramReportIngress } from './report-ingress.js';
describe('report delivery boundary', () => {
  it('delivers only a completed adapter projection and strips provider failures', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('private provider response'));
    const ingress = new TelegramReportIngress(
      {
        handle: () =>
          Promise.resolve({
            handled: true,
            userId: 'trusted-user',
            telegramUserId: '123',
            notice: { key: 'report.submitted', variables: {} },
          }),
      },
      deliver,
    );
    await expect(ingress.handle({})).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const ignored = new TelegramReportIngress(
      { handle: () => Promise.resolve({ handled: false }) },
      deliver,
    );
    await expect(ignored.handle({})).resolves.toBe('unhandled');
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
