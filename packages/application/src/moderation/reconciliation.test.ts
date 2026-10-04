import { describe, expect, it, vi } from 'vitest';
import {
  RunModerationReconciliationBatchHandler,
  type ModerationReconciliationStore,
} from './reconciliation.js';
describe('moderation reconciliation bound', () => {
  it('rejects invalid batch sizes before acquiring or creating a run', async () => {
    const resumeOrStart = vi.fn<ModerationReconciliationStore['resumeOrStart']>();
    const handler = new RunModerationReconciliationBatchHandler({
      resumeOrStart,
      scanNextBatch: vi.fn<ModerationReconciliationStore['scanNextBatch']>(),
    });
    for (const limit of [0, 501, 1.5, Number.NaN])
      await expect(handler.execute({ proposedRunId: 'untrusted', limit })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    expect(resumeOrStart).not.toHaveBeenCalled();
  });
});
