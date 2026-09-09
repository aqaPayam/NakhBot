import { describe, expect, it } from 'vitest';
import { M2_INGESTION_OUTCOMES, M2_MEDIA_REASON_CODES, M2Metrics } from './m2-metrics.js';

describe('M2 metric contract', () => {
  it('exposes only bounded ingestion labels and accepts measurements', () => {
    expect(M2_INGESTION_OUTCOMES).toEqual([
      'accepted',
      'rejected',
      'quarantined',
      'retryable_failure',
    ]);
    expect(M2_MEDIA_REASON_CODES).not.toContain('asset_id');
    const metrics = new M2Metrics();
    expect(() => {
      metrics.recordIngestion('quarantined', 12);
      metrics.recordQuarantineBytes(1024);
    }).not.toThrow();
  });
});
