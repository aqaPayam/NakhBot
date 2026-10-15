import type { AccountDeletionBatchResult, AccountDeletionHealthStore } from '@nakh/application';
import type { M8Metrics } from '@nakh/observability';
type Runtime = Readonly<{ execute: () => Promise<AccountDeletionBatchResult> }>;
type Metrics = Pick<M8Metrics, 'recordBatch' | 'recordHealth' | 'recordHealthFailure'>;
/** Observation never changes lifecycle results or emits provider exceptions.
 * A failed sample retains its old timestamp; close waits for the one in-flight read. */
export class AccountDeletionTelemetry {
  private pending: Promise<void> | undefined;
  private closed = false;
  public constructor(
    private readonly health: AccountDeletionHealthStore,
    private readonly metrics: Metrics,
    private readonly unavailable: (
      operation: 'deletion.health_failed' | 'deletion.telemetry_failed',
    ) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}
  private report(operation: 'deletion.health_failed' | 'deletion.telemetry_failed'): void {
    try {
      this.unavailable(operation);
    } catch {
      /* Diagnostics cannot alter native work. */
    }
  }
  public async execute(runtime: Runtime): Promise<AccountDeletionBatchResult> {
    const start = this.now();
    let result: AccountDeletionBatchResult;
    try {
      result = await runtime.execute();
    } catch {
      result = { outcome: 'failure', phase: 'unknown' };
    }
    try {
      this.metrics.recordBatch(result.outcome, result.phase, Math.max(0, this.now() - start));
    } catch {
      this.report('deletion.telemetry_failed');
    }
    return result;
  }
  public sample(): Promise<void> {
    if (this.closed || this.pending !== undefined) return Promise.resolve();
    const pending = this.read();
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }
  private async read(): Promise<void> {
    try {
      const sample = await this.health.measure();
      this.metrics.recordHealth(sample.sampledAt.getTime(), sample.phases);
    } catch {
      try {
        this.metrics.recordHealthFailure();
      } catch {
        /* The same telemetry outage is reported below. */
      }
      this.report('deletion.health_failed');
    }
  }
  public async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }
}
