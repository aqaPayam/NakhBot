import { describe, expect, it } from 'vitest';

import {
  M4_METRIC_LABEL_KEYS,
  M4_RECONCILIATION_OUTCOMES,
  M4_REFUND_OUTCOMES,
  M4Metrics,
} from './m4-metrics.js';

describe('M4 metric contract', () => {
  it('allows only finite aggregate outcomes and no identity labels', () => {
    expect(M4_RECONCILIATION_OUTCOMES).toEqual(['in_progress', 'completed', 'failure']);
    expect(M4_REFUND_OUTCOMES).toContain('reconciliation_required');
    expect(M4_METRIC_LABEL_KEYS).not.toEqual(
      expect.arrayContaining(['user_id', 'payment_id', 'refund_id', 'charge_id', 'provider_error']),
    );
  });

  it('records billing operations using aggregate counts', () => {
    const metrics = new M4Metrics();
    expect(() => {
      metrics.recordReconciliationBatch('in_progress', 50, 100, 2);
      metrics.recordReconciliationBatch('completed', 40, 20, 0);
      metrics.recordRefund('reconciliation_required', 500);
    }).not.toThrow();
  });
});
