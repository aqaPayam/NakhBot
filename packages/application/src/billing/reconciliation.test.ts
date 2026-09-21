import { describe, expect, it, vi } from 'vitest';

import {
  RunBillingReconciliationBatchHandler,
  type BillingReconciliationStore,
} from './reconciliation.js';

describe('M4 billing reconciliation batch handler', () => {
  it('resumes an unfinished durable run before scanning a bounded batch', async () => {
    const resumeOrStart = vi
      .fn<BillingReconciliationStore['resumeOrStart']>()
      .mockResolvedValue('976a1076-10b9-4c56-a470-786f50209dbc');
    const scanNextBatch = vi.fn<BillingReconciliationStore['scanNextBatch']>().mockResolvedValue({
      runId: '976a1076-10b9-4c56-a470-786f50209dbc',
      scannedCount: 25,
      anomalyCount: 2,
      completed: false,
    });
    const handler = new RunBillingReconciliationBatchHandler({
      resumeOrStart,
      scanNextBatch,
    });
    await expect(
      handler.execute({ proposedRunId: '3b70cd4b-d767-4334-87a7-bd4e536e6adc', limit: 25 }),
    ).resolves.toEqual({
      runId: '976a1076-10b9-4c56-a470-786f50209dbc',
      scannedCount: 25,
      anomalyCount: 2,
      completed: false,
    });
    expect(resumeOrStart).toHaveBeenCalledWith('3b70cd4b-d767-4334-87a7-bd4e536e6adc');
    expect(scanNextBatch).toHaveBeenCalledWith('976a1076-10b9-4c56-a470-786f50209dbc', 25);
  });
});
