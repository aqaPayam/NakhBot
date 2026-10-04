import type {
  ModerationReconciliationPhase,
  RunModerationReconciliationBatchHandler,
} from '@nakh/application';

export type ModerationMaintenanceResult = Readonly<{
  outcome: 'in_progress' | 'completed' | 'failure';
  phase: ModerationReconciliationPhase | 'unknown';
  scannedCount: number;
  anomalyCount: number;
  durationMs: number;
}>;

/** The durable store owns progress and concurrency. This coordinator owns only local cadence.
 * Database exceptions and durable run/entity identifiers never leave this boundary. */
export class ModerationMaintenance {
  private nextAt = 0;
  private running = false;
  public constructor(
    private readonly handler: Pick<RunModerationReconciliationBatchHandler, 'execute'>,
    private readonly uuid: () => string,
    private readonly now: () => number = Date.now,
  ) {}
  public async executeDue(): Promise<ModerationMaintenanceResult | undefined> {
    if (this.running || this.now() < this.nextAt) return undefined;
    this.running = true;
    const startedAt = this.now();
    try {
      const result = await this.handler.execute({ proposedRunId: this.uuid(), limit: 100 });
      this.nextAt = this.now() + (result.completed ? 15 * 60_000 : 0);
      return {
        outcome: result.completed ? 'completed' : 'in_progress',
        phase: result.phase,
        scannedCount: result.scannedCount,
        anomalyCount: result.anomalyCount,
        durationMs: Math.max(0, this.now() - startedAt),
      };
    } catch {
      this.nextAt = this.now() + 60_000;
      return {
        outcome: 'failure',
        phase: 'unknown',
        scannedCount: 0,
        anomalyCount: 0,
        durationMs: Math.max(0, this.now() - startedAt),
      };
    } finally {
      this.running = false;
    }
  }
}
