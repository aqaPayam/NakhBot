import { metrics } from '@opentelemetry/api';

export const M2_INGESTION_OUTCOMES = [
  'accepted',
  'rejected',
  'quarantined',
  'retryable_failure',
] as const;
export type M2IngestionOutcome = (typeof M2_INGESTION_OUTCOMES)[number];

export const M2_MEDIA_REASON_CODES = [
  'none',
  'media_too_large',
  'media_download_invalid',
  'malware_detected',
  'storage_unavailable',
  'scanner_unavailable',
  'rate_limited',
] as const;
export type M2MediaReasonCode = (typeof M2_MEDIA_REASON_CODES)[number];

export const M2_ORPHAN_OBJECT_STATES = ['examined', 'deferred', 'referenced', 'deleted'] as const;

const meter = metrics.getMeter('nakh-m2');

/** Fixed labels only: user/asset IDs, hashes, keys, URLs, filenames, and provider detail
 * must never be supplied as metric attributes. */
export class M2Metrics {
  private readonly ingestion = meter.createCounter('nakh.m2.media.ingestion.count');
  private readonly bytes = meter.createHistogram('nakh.m2.media.quarantine.bytes', { unit: 'By' });
  private readonly duration = meter.createHistogram('nakh.m2.media.ingestion.duration', {
    unit: 'ms',
  });
  private readonly orphanObjects = meter.createCounter('nakh.m2.media.orphan_objects.count');
  private readonly orphanScans = meter.createCounter('nakh.m2.media.orphan_scans.count');

  public recordIngestion(
    outcome: M2IngestionOutcome,
    durationMs: number,
    reasonCode: M2MediaReasonCode = 'none',
  ): void {
    const labels = { outcome, reason_code: reasonCode };
    this.ingestion.add(1, labels);
    this.duration.record(durationMs, labels);
  }

  public recordQuarantineBytes(bytes: number): void {
    this.bytes.record(bytes);
  }

  public recordOrphanReconciliation(
    result: Readonly<Record<(typeof M2_ORPHAN_OBJECT_STATES)[number], number>>,
  ): void {
    for (const state of M2_ORPHAN_OBJECT_STATES) this.orphanObjects.add(result[state], { state });
    this.orphanScans.add(1, { outcome: 'succeeded' });
  }

  public recordOrphanFailure(): void {
    this.orphanScans.add(1, { outcome: 'retryable_failure' });
  }
}
