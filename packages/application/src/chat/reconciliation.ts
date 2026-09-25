import { ApplicationError } from '@nakh/domain';

export const CHAT_RECONCILIATION_PHASES = [
  'sessions',
  'messages',
  'unmatches',
  'deliveries',
] as const;
export type ChatReconciliationPhase = (typeof CHAT_RECONCILIATION_PHASES)[number];

export type ChatReconciliationBatch = Readonly<{
  proposedRunId: string;
  limit: number;
}>;

export type ChatReconciliationBatchResult = Readonly<{
  runId: string;
  phase: ChatReconciliationPhase;
  scannedCount: number;
  anomalyCount: number;
  completed: boolean;
}>;

export interface ChatReconciliationStore {
  resumeOrStart(proposedRunId: string): Promise<string>;
  scanNextBatch(runId: string, limit: number): Promise<ChatReconciliationBatchResult>;
}

/** Runs one bounded, resumable M6 integrity batch; cadence and leadership stay external. */
export class RunChatReconciliationBatchHandler {
  public constructor(private readonly store: ChatReconciliationStore) {}

  public async execute(input: ChatReconciliationBatch): Promise<ChatReconciliationBatchResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      throw new ApplicationError('invalid_request', 'error.chat.reconciliation_invalid', 400);
    const runId = await this.store.resumeOrStart(input.proposedRunId);
    return this.store.scanNextBatch(runId, input.limit);
  }
}
