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
import {
  M7Metrics,
  M7_METRIC_LABEL_KEYS,
  M7_RECONCILIATION_PHASES,
  type M7ReconciliationPhase,
} from './m7-metrics.js';
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

describe('current M7 integrity sampling', () => {
  it('emits exactly ten fixed phase counts and sample freshness, validating the whole sample first', () => {
    const phases = M7_RECONCILIATION_PHASES.filter((phase) => phase !== 'unknown');
    const counts = Object.fromEntries(phases.map((phase) => [phase, 0])) as Record<
      Exclude<M7ReconciliationPhase, 'unknown'>,
      number
    >;
    counts.evidence = 2;
    const metrics = new M7Metrics();
    samples.record.mockClear();
    metrics.recordOperationalIntegrity(1700000000000, counts);
    expect(samples.record.mock.calls).toEqual([
      ...phases.map((phase) => [counts[phase], { phase }]),
      [1700000000],
    ]);
    for (const invalid of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      samples.record.mockClear();
      expect(() =>
        metrics.recordOperationalIntegrity(1700000000000, { ...counts, actions: invalid }),
      ).toThrow('M7 metric value invalid');
      expect(samples.record).not.toHaveBeenCalled();
    }
    expect(() => metrics.recordOperationalIntegrity(Number.NaN, counts)).toThrow(
      'M7 metric value invalid',
    );
    expect(() =>
      metrics.recordOperationalIntegrity(1700000000000, { ...counts, ...{ privateUserId: 5 } }),
    ).toThrow('M7 metric value invalid');
  });
});
