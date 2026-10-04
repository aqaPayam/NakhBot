import { metrics } from '@opentelemetry/api';

export const M7_RECONCILIATION_PHASES = [
  'reports',
  'evidence',
  'reviews',
  'actions',
  'episodes',
  'support_threads',
  'appeals',
  'admins',
  'admin_logs',
  'internal_blocks',
  'unknown',
] as const;
export type M7ReconciliationPhase = (typeof M7_RECONCILIATION_PHASES)[number];
export const M7_RECONCILIATION_OUTCOMES = ['in_progress', 'completed', 'failure'] as const;
export type M7ReconciliationOutcome = (typeof M7_RECONCILIATION_OUTCOMES)[number];
export const M7_METRIC_LABEL_KEYS = ['phase', 'outcome'] as const;
export type M7OperationalLiveness = Readonly<{
  oldestPendingReportAgeSeconds: number;
  oldestInReviewAgeSeconds: number;
  activeReconciliationAgeSeconds: number;
  completedReconciliationAgeSeconds: number;
  reconciliationNeverCompleted: number;
}>;
const meter = metrics.getMeter('nakh-m7');
/** Finite phases/outcomes only. IDs, prose, reasons, locale, tokens and errors are forbidden. */
export class M7Metrics {
  private readonly batches = meter.createCounter('nakh.m7.reconciliation.batches');
  private readonly duration = meter.createHistogram('nakh.m7.reconciliation.duration', {
    unit: 'ms',
  });
  private readonly scanned = meter.createCounter('nakh.m7.reconciliation.scanned');
  private readonly findings = meter.createCounter('nakh.m7.reconciliation.new_findings');
  private readonly failures = meter.createCounter('nakh.m7.reconciliation.failures');
  private readonly healthFailures = meter.createCounter('nakh.m7.operational_health.failures');
  private readonly pendingAge = meter.createGauge('nakh.m7.backlog.pending_report_oldest_age', {
    unit: 's',
  });
  private readonly inReviewAge = meter.createGauge('nakh.m7.backlog.in_review_oldest_age', {
    unit: 's',
  });
  private readonly activeAge = meter.createGauge('nakh.m7.reconciliation.active_age', {
    unit: 's',
  });
  private readonly completedAge = meter.createGauge('nakh.m7.reconciliation.completed_age', {
    unit: 's',
  });
  private readonly neverCompleted = meter.createGauge('nakh.m7.reconciliation.never_completed');
  public recordReconciliation(
    outcome: M7ReconciliationOutcome,
    phase: M7ReconciliationPhase,
    durationMs: number,
    scanned = 0,
    findings = 0,
  ): void {
    const labels = {
      outcome: M7_RECONCILIATION_OUTCOMES.includes(outcome) ? outcome : 'failure',
      phase: M7_RECONCILIATION_PHASES.includes(phase) ? phase : 'unknown',
    };
    if (![durationMs, scanned, findings].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error('M7 metric value invalid.');
    this.batches.add(1, labels);
    this.duration.record(durationMs, labels);
    this.scanned.add(scanned, { phase: labels.phase });
    this.findings.add(findings, { phase: labels.phase });
    if (labels.outcome === 'failure') this.failures.add(1);
  }
  public recordOperationalHealth(health: M7OperationalLiveness): void {
    const values = [
      health.oldestPendingReportAgeSeconds,
      health.oldestInReviewAgeSeconds,
      health.activeReconciliationAgeSeconds,
      health.completedReconciliationAgeSeconds,
      health.reconciliationNeverCompleted,
    ];
    if (
      !values.every((value) => Number.isFinite(value) && value >= 0) ||
      ![0, 1].includes(health.reconciliationNeverCompleted)
    )
      throw new Error('M7 metric value invalid.');
    this.pendingAge.record(health.oldestPendingReportAgeSeconds);
    this.inReviewAge.record(health.oldestInReviewAgeSeconds);
    this.activeAge.record(health.activeReconciliationAgeSeconds);
    this.completedAge.record(health.completedReconciliationAgeSeconds);
    this.neverCompleted.record(health.reconciliationNeverCompleted);
  }
  public recordOperationalHealthFailure(): void {
    this.healthFailures.add(1);
  }
}
