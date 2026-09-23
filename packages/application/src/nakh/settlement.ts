import { MAX_PENDING_NAKHES_PER_SENDER, type IdGenerator } from '@nakh/domain';

export type PendingNakhSettlementRequest = Readonly<{
  senderUserId: string;
  triggerCreditTransactionId: string;
  causationId: string;
}>;

export type PendingNakhSettlementWrite = PendingNakhSettlementRequest &
  Readonly<{
    nakhId: string;
    historyId: string;
    creditTransactionId: string;
    terminalEventId: string;
  }>;

export type PendingNakhSettlementStepResult = Readonly<{
  outcome:
    | 'idle'
    | 'closed_and_continue'
    | 'delivered_and_continue'
    | 'stop_insufficient_credits'
    | 'stop_external_funding';
  pendingNakhId?: string;
}>;

export interface PendingNakhSettlementStore {
  settleOldest(write: PendingNakhSettlementWrite): Promise<PendingNakhSettlementStepResult>;
}

export type PendingNakhSettlementResult = Readonly<{
  deliveredCount: number;
  closedCount: number;
  stopped: 'queue_empty' | 'insufficient_credits' | 'external_funding' | 'queue_bound';
}>;

/** Runs one bounded FIFO pass; every step is a separate atomic and replay-safe transaction. */
export class SettlePendingNakhesHandler {
  public constructor(
    private readonly store: PendingNakhSettlementStore,
    private readonly ids: Pick<IdGenerator, 'uuid'>,
  ) {}

  public async execute(
    request: PendingNakhSettlementRequest,
  ): Promise<PendingNakhSettlementResult> {
    let deliveredCount = 0;
    let closedCount = 0;
    for (let step = 0; step < MAX_PENDING_NAKHES_PER_SENDER; step += 1) {
      const result = await this.store.settleOldest({
        ...request,
        nakhId: this.ids.uuid(),
        historyId: this.ids.uuid(),
        creditTransactionId: this.ids.uuid(),
        terminalEventId: this.ids.uuid(),
      });
      if (result.outcome === 'delivered_and_continue') {
        deliveredCount += 1;
        continue;
      }
      if (result.outcome === 'closed_and_continue') {
        closedCount += 1;
        continue;
      }
      return {
        deliveredCount,
        closedCount,
        stopped:
          result.outcome === 'idle'
            ? 'queue_empty'
            : result.outcome === 'stop_external_funding'
              ? 'external_funding'
              : 'insufficient_credits',
      };
    }
    return { deliveredCount, closedCount, stopped: 'queue_bound' };
  }
}
