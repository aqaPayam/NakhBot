import { metrics } from '@opentelemetry/api';

export const M4_RECONCILIATION_OUTCOMES = ['in_progress', 'completed', 'failure'] as const;
export type M4ReconciliationOutcome = (typeof M4_RECONCILIATION_OUTCOMES)[number];
export const M4_REFUND_OUTCOMES = [
  'processed',
  'replayed',
  'retryable',
  'reconciliation_required',
  'terminal_failure',
  'lease_lost',
] as const;
export type M4RefundOutcome = (typeof M4_REFUND_OUTCOMES)[number];
export const M4_METRIC_LABEL_KEYS = ['outcome'] as const;

const meter = metrics.getMeter('nakh-m4');

/** Fixed aggregate outcomes only; payment, refund, charge, user, and provider IDs are forbidden. */
export class M4Metrics {
  private readonly reconciliationBatches = meter.createCounter(
    'nakh.m4.billing.reconciliation.batches',
  );
  private readonly reconciliationDuration = meter.createHistogram(
    'nakh.m4.billing.reconciliation.duration',
    { unit: 'ms' },
  );
  private readonly reconciliationScanned = meter.createCounter(
    'nakh.m4.billing.reconciliation.scanned',
  );
  private readonly reconciliationAnomalies = meter.createCounter(
    'nakh.m4.billing.reconciliation.anomalies',
  );
  private readonly refunds = meter.createCounter('nakh.m4.billing.refunds');
  private readonly refundDuration = meter.createHistogram('nakh.m4.billing.refund.duration', {
    unit: 'ms',
  });

  public recordReconciliationBatch(
    outcome: M4ReconciliationOutcome,
    durationMs: number,
    scannedCount = 0,
    anomalyCount = 0,
  ): void {
    this.reconciliationBatches.add(1, { outcome });
    this.reconciliationDuration.record(durationMs, { outcome });
    this.reconciliationScanned.add(scannedCount);
    this.reconciliationAnomalies.add(anomalyCount);
  }

  public recordRefund(outcome: M4RefundOutcome, durationMs: number): void {
    this.refunds.add(1, { outcome });
    this.refundDuration.record(durationMs, { outcome });
  }
}
