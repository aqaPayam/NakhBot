import { describe, expect, it } from 'vitest';

import {
  M1_HANDLER_OPERATIONS,
  M1_METRIC_LABEL_KEYS,
  M1_OUTCOMES,
  M1_REASON_CODES,
  M1Metrics,
} from './m1-metrics.js';

describe('M1 metric contract', () => {
  it('uses finite operation, outcome, reason, and label registries', () => {
    expect(M1_HANDLER_OPERATIONS).toHaveLength(9);
    expect(M1_OUTCOMES).toEqual(['success', 'replay', 'denied', 'conflict', 'failure']);
    expect(M1_REASON_CODES).toContain('guest_preview_limit_reached');
    expect(M1_METRIC_LABEL_KEYS).not.toEqual(
      expect.arrayContaining(['user_id', 'telegram_user_id', 'request_id', 'locale']),
    );
  });

  it('accepts only bounded business dimensions', () => {
    const metrics = new M1Metrics();
    expect(() => {
      metrics.recordHandler('guest_preview_consume', 'denied', 12, 'guest_preview_limit_reached');
      metrics.recordSignup('completed');
      metrics.recordProfileCompletion('invalidated');
      metrics.recordGuestPreview('consumed');
      metrics.recordProtectedChange('approved');
      metrics.recordOutboxUnpublishedAge(3);
    }).not.toThrow();
  });
});
