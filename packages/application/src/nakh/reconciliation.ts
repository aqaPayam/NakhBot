export type NakhReconciliationBatch = Readonly<{
  proposedRunId: string;
  limit: number;
}>;

export type NakhReconciliationBatchResult = Readonly<{
  runId: string;
  phase: 'flows' | 'counters' | 'pending' | 'delivered';
  scannedCount: number;
  anomalyCount: number;
  completed: boolean;
}>;

export interface NakhReconciliationStore {
  resumeOrStart(proposedRunId: string): Promise<string>;
  scanNextBatch(runId: string, limit: number): Promise<NakhReconciliationBatchResult>;
}

/** Runs one bounded, resumable Nakh integrity batch; the scheduler owns cadence and leadership. */
export class RunNakhReconciliationBatchHandler {
  public constructor(private readonly store: NakhReconciliationStore) {}

  public async execute(input: NakhReconciliationBatch): Promise<NakhReconciliationBatchResult> {
    const runId = await this.store.resumeOrStart(input.proposedRunId);
    return this.store.scanNextBatch(runId, input.limit);
  }
}
