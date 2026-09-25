import { describe, expect, it, vi } from 'vitest';

import {
  RunChatReconciliationBatchHandler,
  type ChatReconciliationStore,
} from './reconciliation.js';

describe('M6 chat reconciliation handler', () => {
  it('resumes a run before scanning one bounded batch', async () => {
    const resumeOrStart = vi.fn().mockResolvedValue('10000000-0000-4000-8000-000000000001');
    const scanNextBatch = vi.fn().mockResolvedValue({
      runId: '10000000-0000-4000-8000-000000000001',
      phase: 'sessions',
      scannedCount: 3,
      anomalyCount: 0,
      completed: false,
    });
    const store: ChatReconciliationStore = {
      resumeOrStart,
      scanNextBatch,
    };
    const handler = new RunChatReconciliationBatchHandler(store);
    await expect(
      handler.execute({
        proposedRunId: '10000000-0000-4000-8000-000000000002',
        limit: 100,
      }),
    ).resolves.toMatchObject({ phase: 'sessions', scannedCount: 3 });
    expect(scanNextBatch).toHaveBeenCalledWith('10000000-0000-4000-8000-000000000001', 100);
  });

  it('rejects an unbounded scan before touching persistence', async () => {
    const resumeOrStart = vi.fn();
    const store: ChatReconciliationStore = {
      resumeOrStart,
      scanNextBatch: vi.fn(),
    };
    const handler = new RunChatReconciliationBatchHandler(store);
    await expect(
      handler.execute({
        proposedRunId: '10000000-0000-4000-8000-000000000002',
        limit: 501,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(resumeOrStart).not.toHaveBeenCalled();
  });
});
