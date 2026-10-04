import { ApplicationError } from '@nakh/domain';
export const MODERATION_RECONCILIATION_PHASES = [
  'reports',
  'evidence',
  'reviews',
  'actions',
  'episodes',
] as const;
export type ModerationReconciliationPhase = (typeof MODERATION_RECONCILIATION_PHASES)[number];
export type ModerationReconciliationBatchResult = Readonly<{
  runId: string;
  phase: ModerationReconciliationPhase;
  scannedCount: number;
  anomalyCount: number;
  completed: boolean;
}>;
export interface ModerationReconciliationStore {
  resumeOrStart(proposedRunId: string): Promise<string>;
  scanNextBatch(runId: string, limit: number): Promise<ModerationReconciliationBatchResult>;
}
/** One bounded metadata scan; leadership and cadence remain owned by the scheduler. */
export class RunModerationReconciliationBatchHandler {
  public constructor(private readonly store: ModerationReconciliationStore) {}
  public async execute(
    input: Readonly<{ proposedRunId: string; limit: number }>,
  ): Promise<ModerationReconciliationBatchResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    return this.store.scanNextBatch(
      await this.store.resumeOrStart(input.proposedRunId),
      input.limit,
    );
  }
}
