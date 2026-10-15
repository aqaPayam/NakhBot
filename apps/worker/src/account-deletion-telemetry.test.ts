import { describe, expect, it, vi, type Mock, type Mocked } from 'vitest';
import { ACCOUNT_DELETION_PHASES } from '@nakh/domain';
import { M8_DELETION_PHASES, type M8Metrics } from '@nakh/observability';
import type { AccountDeletionHealthSample } from '@nakh/application';
import { AccountDeletionTelemetry } from './account-deletion-telemetry.js';
function fixture(): {
  sample: AccountDeletionHealthSample;
  health: { measure: Mock<() => Promise<AccountDeletionHealthSample>> };
  metrics: Mocked<Pick<M8Metrics, 'recordBatch' | 'recordHealth' | 'recordHealthFailure'>>;
  unavailable: Mock;
  monitor: AccountDeletionTelemetry;
} {
  const sample: AccountDeletionHealthSample = {
    sampledAt: new Date(1700000000000),
    phases: Object.fromEntries(
      ACCOUNT_DELETION_PHASES.map((p) => [
        p,
        {
          records: 1,
          leased: 0,
          retrying: 0,
          inconsistent: 0,
          oldestAgeSeconds: 1,
          dueAgeSeconds: 1,
        },
      ]),
    ) as AccountDeletionHealthSample['phases'],
  };
  const health = { measure: vi.fn(() => Promise.resolve(sample)) },
    metrics = { recordBatch: vi.fn(), recordHealth: vi.fn(), recordHealthFailure: vi.fn() },
    unavailable = vi.fn();
  return {
    sample,
    health,
    metrics,
    unavailable,
    monitor: new AccountDeletionTelemetry(health, metrics, unavailable, () => 10),
  };
}
describe('actual worker deletion telemetry boundary', () => {
  it('keeps domain and telemetry phases aligned and observes successful native outcomes', async () => {
    expect(M8_DELETION_PHASES).toEqual(ACCOUNT_DELETION_PHASES);
    const f = fixture(),
      result = { outcome: 'completed', phase: 'verification' } as const;
    expect(await f.monitor.execute({ execute: () => Promise.resolve(result) })).toBe(result);
    expect(f.metrics.recordBatch).toHaveBeenCalledWith('completed', 'verification', 0);
  });
  it('preserves a committed native result through an exporter outage and sanitizes unexpected runtime failure', async () => {
    const f = fixture(),
      result = { outcome: 'completed', phase: 'verification' } as const;
    f.metrics.recordBatch.mockImplementation(() => {
      throw Error('PRIVATE exporter');
    });
    expect(await f.monitor.execute({ execute: () => Promise.resolve(result) })).toBe(result);
    expect(
      await f.monitor.execute({ execute: () => Promise.reject(Error('PRIVATE provider')) }),
    ).toEqual({ outcome: 'failure', phase: 'unknown' });
    expect(JSON.stringify(f.unavailable.mock.calls)).not.toContain('PRIVATE');
  });
  it('does not refresh the sample on database failure and recovers on the next read', async () => {
    const f = fixture();
    f.health.measure.mockRejectedValueOnce(Error('PRIVATE query'));
    await f.monitor.sample();
    expect(f.metrics.recordHealth).not.toHaveBeenCalled();
    expect(f.metrics.recordHealthFailure).toHaveBeenCalledOnce();
    expect(f.unavailable).toHaveBeenCalledWith('deletion.health_failed');
    await f.monitor.sample();
    expect(f.metrics.recordHealth).toHaveBeenCalledWith(
      f.sample.sampledAt.getTime(),
      f.sample.phases,
    );
  });
  it('prevents overlapping health reads and drains the current sample before close', async () => {
    const f = fixture();
    let release!: (v: AccountDeletionHealthSample) => void;
    f.health.measure.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const first = f.monitor.sample();
    await f.monitor.sample();
    expect(f.health.measure).toHaveBeenCalledOnce();
    let closed = false;
    const closing = f.monitor.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(f.sample);
    await first;
    await closing;
    await f.monitor.sample();
    expect(f.health.measure).toHaveBeenCalledOnce();
  });
});
