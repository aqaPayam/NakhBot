import { describe, expect, it } from 'vitest';
import {
  M2_INGESTION_OUTCOMES,
  M2_MEDIA_REASON_CODES,
  M2_ORPHAN_OBJECT_STATES,
  M2Metrics,
} from './m2-metrics.js';

describe('M2 metric contract', () => {
  it('exposes only bounded ingestion labels and accepts measurements', () => {
    expect(M2_INGESTION_OUTCOMES).toEqual([
      'accepted',
      'rejected',
      'quarantined',
      'retryable_failure',
    ]);
    expect(M2_MEDIA_REASON_CODES).not.toContain('asset_id');
    expect(M2_ORPHAN_OBJECT_STATES).toEqual(['examined', 'deferred', 'referenced', 'deleted']);
    const metrics = new M2Metrics();
    expect(() => {
      metrics.recordIngestion('quarantined', 12);
      metrics.recordQuarantineBytes(1024);
      metrics.recordOrphanReconciliation({ examined: 3, deferred: 1, referenced: 1, deleted: 1 });
      metrics.recordOrphanFailure();
    }).not.toThrow();
  });
});
