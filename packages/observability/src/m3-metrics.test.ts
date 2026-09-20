import { describe, expect, it } from 'vitest';

import {
  M3_METRIC_LABEL_KEYS,
  M3_TELEGRAM_DELIVERY_OUTCOMES,
  M3_TELEGRAM_INGRESS_OUTCOMES,
  M3_TELEGRAM_REASON_CODES,
  M3Metrics,
} from './m3-metrics.js';

describe('M3 metric contract', () => {
  it('uses finite outcome, reason, and label registries', () => {
    expect(M3_TELEGRAM_INGRESS_OUTCOMES).toEqual([
      'enqueued',
      'replayed',
      'notice',
      'rejected',
      'failure',
    ]);
    expect(M3_TELEGRAM_DELIVERY_OUTCOMES).toContain('lease_lost');
    expect(M3_TELEGRAM_REASON_CODES).toContain('provider_timeout');
    expect(M3_METRIC_LABEL_KEYS).not.toEqual(
      expect.arrayContaining([
        'user_id',
        'telegram_user_id',
        'request_id',
        'delivery_id',
        'locale',
      ]),
    );
  });

  it('records aggregate operations without identity dimensions', () => {
    const metrics = new M3Metrics();
    expect(() => {
      metrics.recordTelegramIngress('enqueued', 8);
      metrics.recordTelegramIngress('rejected', 5, 'rate_limited');
      metrics.recordTelegramDelivery('retry_scheduled', 120, 'provider_timeout');
      metrics.recordTelegramDelivery('lease_lost', 30);
      metrics.recordTelegramBacklog(12, 45);
      metrics.recordTelegramBacklogFailure();
    }).not.toThrow();
  });
});
