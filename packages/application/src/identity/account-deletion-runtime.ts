import { ACCOUNT_DELETION_PHASES, ApplicationError, type AccountDeletionPhase } from '@nakh/domain';
import type { AccountDeletionLease, AccountDeletionWorkStore } from './account-deletion.js';

export type AccountDeletionStepOutcome = 'progress' | 'waiting' | 'advanced' | 'completed';
export interface AccountDeletionPhaseExecutor {
  executeNext(lease: AccountDeletionLease): Promise<AccountDeletionStepOutcome>;
}
export type AccountDeletionBatchResult = Readonly<{
  outcome:
    | AccountDeletionStepOutcome
    | 'idle'
    | 'busy'
    | 'closed'
    | 'retry_scheduled'
    | 'lease_lost'
    | 'failure';
  phase: AccountDeletionPhase | 'unknown';
}>;

/** One native lease and one bounded step per poll. Native receipts own phase
 * advancement; provider calls and private failure details stay behind the executor.
 * Closing waits for the current step before a host closes its database/providers. */
export class RunAccountDeletionBatchHandler {
  private pending: Promise<AccountDeletionBatchResult> | undefined;
  private closed = false;
  public constructor(
    private readonly work: AccountDeletionWorkStore,
    private readonly executor: AccountDeletionPhaseExecutor,
    private readonly workerId: string,
  ) {}

  public execute(): Promise<AccountDeletionBatchResult> {
    if (this.closed) return Promise.resolve({ outcome: 'closed', phase: 'unknown' });
    if (this.pending !== undefined) return Promise.resolve({ outcome: 'busy', phase: 'unknown' });
    const pending = this.run();
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }
  public async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }
  private async run(): Promise<AccountDeletionBatchResult> {
    let scope: AccountDeletionLease | undefined;
    let phase: AccountDeletionPhase | 'unknown' = 'unknown';
    try {
      const leases = await this.work.claimDue({
        workerId: this.workerId,
        limit: 1,
        leaseMs: 120000,
      });
      if (leases.length === 0) return { outcome: 'idle', phase: 'unknown' };
      if (leases.length !== 1) throw new Error('Invalid deletion claim');
      const claimed = leases[0]!;
      scope = Object.freeze({ ...claimed, leaseExpiresAt: new Date(claimed.leaseExpiresAt) });
      const index = ACCOUNT_DELETION_PHASES.indexOf(scope.phase);
      if (index < 0 || scope.phase === 'completed' || scope.checkpointVersion !== index + 1)
        throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
      phase = scope.phase;
      // Keep release/retry authority separate from objects passed to an adapter.
      const outcome = await this.executor.executeNext(
        Object.freeze({
          ...scope,
          leaseExpiresAt: new Date(scope.leaseExpiresAt),
        }),
      );
      if (outcome === 'completed' && scope.phase === 'verification')
        return { outcome, phase: scope.phase };
      if (outcome === 'advanced' && scope.phase !== 'verification')
        return { outcome, phase: scope.phase };
      if (outcome === 'progress') {
        await this.work.release(scope);
        return { outcome, phase: scope.phase };
      }
      if (outcome === 'waiting') {
        await this.work.retry(
          scope,
          scope.phase === 'evidence_capture'
            ? 'deletion_evidence_pending'
            : 'deletion_verification_failed',
          60,
        );
        return { outcome, phase: scope.phase };
      }
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    } catch {
      if (scope === undefined) return { outcome: 'failure', phase: 'unknown' };
      try {
        await this.work.retry(scope, 'deletion_phase_failed', 60);
        return { outcome: 'retry_scheduled', phase };
      } catch {
        // The step may have committed before a response was lost. Never undo it
        // or retry with guessed current authority; a new native claim resumes it.
        return { outcome: 'lease_lost', phase };
      }
    }
  }
}
