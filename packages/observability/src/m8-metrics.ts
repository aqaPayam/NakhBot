import { metrics } from '@opentelemetry/api';
export const M8_DELETION_PHASES = [
  'shared_closure',
  'evidence_capture',
  'product_data',
  'media_objects',
  'ephemeral_access',
  'retention_manifest',
  'verification',
  'completed',
] as const;
export type M8DeletionPhase = (typeof M8_DELETION_PHASES)[number];
export const M8_DELETION_OUTCOMES = [
  'progress',
  'waiting',
  'advanced',
  'completed',
  'idle',
  'busy',
  'closed',
  'retry_scheduled',
  'lease_lost',
  'failure',
] as const;
export type M8DeletionOutcome = (typeof M8_DELETION_OUTCOMES)[number];
export const M8_HEALTH_FIELDS = [
  'records',
  'leased',
  'retrying',
  'inconsistent',
  'oldestAgeSeconds',
  'dueAgeSeconds',
] as const;
export type M8PhaseHealth = Readonly<Record<(typeof M8_HEALTH_FIELDS)[number], number>>;
const meter = metrics.getMeter('nakh-m8');
/** Finite phase/outcome only. No owner, Root, provider, key, code or error labels. */
export class M8Metrics {
  private readonly batches = meter.createCounter('nakh.m8.deletion.batches');
  private readonly duration = meter.createHistogram('nakh.m8.deletion.duration', { unit: 'ms' });
  private readonly retries = meter.createCounter('nakh.m8.deletion.retries');
  private readonly lost = meter.createCounter('nakh.m8.deletion.lease_lost');
  private readonly failures = meter.createCounter('nakh.m8.deletion.failures');
  private readonly healthFailures = meter.createCounter('nakh.m8.deletion.health.failures');
  private readonly health = {
    records: meter.createGauge('nakh.m8.deletion.records'),
    leased: meter.createGauge('nakh.m8.deletion.leased'),
    retrying: meter.createGauge('nakh.m8.deletion.retrying'),
    inconsistent: meter.createGauge('nakh.m8.deletion.inconsistent'),
    oldestAgeSeconds: meter.createGauge('nakh.m8.deletion.oldest_age', { unit: 's' }),
    dueAgeSeconds: meter.createGauge('nakh.m8.deletion.due_age', { unit: 's' }),
  };
  private readonly sampledAt = meter.createGauge('nakh.m8.deletion.sampled_at', { unit: 's' });
  public recordBatch(
    outcome: M8DeletionOutcome,
    phase: M8DeletionPhase | 'unknown',
    durationMs: number,
  ): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('M8 metric value invalid.');
    const labels = {
      outcome: M8_DELETION_OUTCOMES.includes(outcome) ? outcome : 'failure',
      phase: M8_DELETION_PHASES.includes(phase as M8DeletionPhase) ? phase : 'unknown',
    };
    this.batches.add(1, labels);
    this.duration.record(durationMs, labels);
    if (labels.outcome === 'retry_scheduled') this.retries.add(1);
    if (labels.outcome === 'lease_lost') this.lost.add(1);
    if (labels.outcome === 'failure') this.failures.add(1);
  }
  public recordHealth(
    sampledAtMs: number,
    phases: Readonly<Record<M8DeletionPhase, M8PhaseHealth>>,
  ): void {
    if (
      !Number.isFinite(sampledAtMs) ||
      sampledAtMs <= 0 ||
      Object.keys(phases).length !== M8_DELETION_PHASES.length ||
      !M8_DELETION_PHASES.every((p) => {
        const h = phases[p];
        return (
          h !== undefined &&
          Object.keys(h).length === M8_HEALTH_FIELDS.length &&
          M8_HEALTH_FIELDS.every(
            (f) => Number.isFinite(h[f]) && h[f] >= 0 && h[f] <= Number.MAX_SAFE_INTEGER,
          ) &&
          [h.records, h.leased, h.retrying, h.inconsistent].every(Number.isSafeInteger) &&
          [h.leased, h.retrying, h.inconsistent].every((v) => v <= h.records)
        );
      })
    )
      throw new Error('M8 metric value invalid.');
    for (const phase of M8_DELETION_PHASES)
      for (const field of M8_HEALTH_FIELDS)
        this.health[field].record(phases[phase][field], { phase });
    this.sampledAt.record(sampledAtMs / 1000);
  }
  public recordHealthFailure(): void {
    this.healthFailures.add(1);
  }
}
