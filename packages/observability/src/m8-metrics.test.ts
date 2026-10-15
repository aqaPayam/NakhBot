import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ add: vi.fn(), record: vi.fn() }));
vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: (name: string) => ({
        add: (...args: unknown[]): void => {
          calls.add(name, ...args);
        },
      }),
      createHistogram: (name: string) => ({
        record: (...args: unknown[]): void => {
          calls.record(name, ...args);
        },
      }),
      createGauge: (name: string) => ({
        record: (...args: unknown[]): void => {
          calls.record(name, ...args);
        },
      }),
    }),
  },
}));
import {
  M8Metrics,
  M8_DELETION_PHASES,
  M8_HEALTH_FIELDS,
  type M8DeletionPhase,
  type M8DeletionOutcome,
  type M8PhaseHealth,
} from './m8-metrics.js';
function health(): Record<M8DeletionPhase, M8PhaseHealth> {
  return Object.fromEntries(
    M8_DELETION_PHASES.map((p) => [
      p,
      {
        records: 2,
        leased: 1,
        retrying: 1,
        inconsistent: 0,
        oldestAgeSeconds: 2.5,
        dueAgeSeconds: 1.5,
      },
    ]),
  ) as Record<M8DeletionPhase, M8PhaseHealth>;
}
describe('M8 finite deletion telemetry', () => {
  it('maps unexpected phase and outcome to fixed labels without leaking private values', () => {
    calls.add.mockClear();
    calls.record.mockClear();
    const m = new M8Metrics();
    m.recordBatch('PRIVATE' as M8DeletionOutcome, 'PRIVATE' as M8DeletionPhase, 5);
    expect(calls.add).toHaveBeenCalledWith('nakh.m8.deletion.batches', 1, {
      outcome: 'failure',
      phase: 'unknown',
    });
    expect(JSON.stringify([...calls.add.mock.calls, ...calls.record.mock.calls])).not.toContain(
      'PRIVATE',
    );
    m.recordBatch('retry_scheduled', 'media_objects', 2);
    m.recordBatch('lease_lost', 'verification', 2);
    m.recordHealthFailure();
    for (const n of ['retries', 'lease_lost', 'failures', 'health.failures'])
      expect(calls.add).toHaveBeenCalledWith('nakh.m8.deletion.' + n, 1);
  });
  it('emits all six aggregates for each phase followed by a single native sample timestamp', () => {
    calls.record.mockClear();
    new M8Metrics().recordHealth(1700000000000, health());
    expect(calls.record).toHaveBeenCalledTimes(
      M8_DELETION_PHASES.length * M8_HEALTH_FIELDS.length + 1,
    );
    expect(calls.record.mock.calls.at(-1)).toEqual(['nakh.m8.deletion.sampled_at', 1700000000]);
    for (const [, value, labels] of calls.record.mock.calls.slice(0, -1)) {
      expect(typeof value).toBe('number');
      expect(Object.keys(labels as object)).toEqual(['phase']);
    }
  });
  it('validates the entire sample before emitting any health point or fresh timestamp', () => {
    const m = new M8Metrics();
    for (const bad of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      calls.record.mockClear();
      expect(() =>
        m.recordHealth(1700000000000, {
          ...health(),
          verification: { ...health().verification, records: bad },
        }),
      ).toThrow('M8 metric value invalid');
      expect(calls.record).not.toHaveBeenCalled();
    }
    for (const bad of [NaN, 0, -1])
      expect(() => m.recordHealth(bad, health())).toThrow('M8 metric value invalid');
    const sample = health();
    sample.verification = { ...sample.verification, leased: 3 };
    expect(() => m.recordHealth(1700000000000, sample)).toThrow();
    expect(() =>
      m.recordHealth(1700000000000, { ...health(), PRIVATE: 1 } as unknown as ReturnType<
        typeof health
      >),
    ).toThrow();
    expect(() => m.recordBatch('completed', 'verification', NaN)).toThrow();
  });
});
