export type BillingReconciliationBatch = Readonly<{
  proposedRunId: string;
  limit: number;
}>;

export type BillingReconciliationBatchResult = Readonly<{
  runId: string;
  scannedCount: number;
  anomalyCount: number;
  completed: boolean;
}>;

export interface BillingReconciliationStore {
  resumeOrStart(proposedRunId: string): Promise<string>;
  scanNextBatch(runId: string, limit: number): Promise<BillingReconciliationBatchResult>;
}

/** Runs one bounded, resumable database batch; the scheduler controls cadence and leadership. */
export class RunBillingReconciliationBatchHandler {
  public constructor(private readonly store: BillingReconciliationStore) {}

  public async execute(
    input: BillingReconciliationBatch,
  ): Promise<BillingReconciliationBatchResult> {
    const runId = await this.store.resumeOrStart(input.proposedRunId);
    return this.store.scanNextBatch(runId, input.limit);
  }
}
