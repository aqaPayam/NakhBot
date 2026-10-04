import { describe, expect, it, vi } from 'vitest';
const samples = vi.hoisted(() => ({ add: vi.fn(), record: vi.fn() }));
vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: samples.add }),
      createHistogram: () => ({ record: samples.record }),
      createGauge: () => ({ record: samples.record }),
    }),
  },
}));
import { M7Metrics, M7_METRIC_LABEL_KEYS, type M7ReconciliationPhase } from './m7-metrics.js';
describe('M7 metric privacy boundary', () => {
  it('uses fixed labels even if an unexpected private phase reaches the runtime boundary', () => {
    samples.add.mockClear();
    samples.record.mockClear();
    const metrics = new M7Metrics();
    metrics.recordReconciliation('in_progress', 'appeals', 5, 100, 1);
    metrics.recordReconciliation('failure', 'private-user-or-text' as M7ReconciliationPhase, 10);
    metrics.recordOperationalHealth({
      oldestPendingReportAgeSeconds: 5,
      oldestInReviewAgeSeconds: 2,
      activeReconciliationAgeSeconds: 0,
      completedReconciliationAgeSeconds: 30,
      reconciliationNeverCompleted: 0,
    });
    metrics.recordOperationalHealthFailure();
    expect(M7_METRIC_LABEL_KEYS).toEqual(['phase', 'outcome']);
    expect(JSON.stringify([...samples.add.mock.calls, ...samples.record.mock.calls])).not.toContain(
      'private-user-or-text',
    );
    expect(samples.add).toHaveBeenCalledWith(1, { outcome: 'failure', phase: 'unknown' });
    expect(() => metrics.recordReconciliation('completed', 'reports', Number.NaN)).toThrow(
      'M7 metric value invalid',
    );
  });
});
