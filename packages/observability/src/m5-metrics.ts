import { metrics } from '@opentelemetry/api';

export const M5_FUNDING_TYPES = ['credits', 'telegram_stars'] as const;
export type M5FundingType = (typeof M5_FUNDING_TYPES)[number];
export const M5_CREATION_OUTCOMES = ['created', 'replayed', 'rejected', 'failure'] as const;
export type M5CreationOutcome = (typeof M5_CREATION_OUTCOMES)[number];
export const M5_DELIVERY_OUTCOMES = [
  'delivered',
  'closed',
  'correction_required',
  'retry_scheduled',
  'lease_lost',
  'failure',
] as const;
export type M5DeliveryOutcome = (typeof M5_DELIVERY_OUTCOMES)[number];
export const M5_SETTLEMENT_STOP_REASONS = [
  'queue_empty',
  'insufficient_credits',
  'external_funding',
  'queue_bound',
  'failure',
] as const;
export type M5SettlementStopReason = (typeof M5_SETTLEMENT_STOP_REASONS)[number];
export const M5_MAINTENANCE_OPERATIONS = [
  'batch',
  'pending_expiry',
  'delivered_expiry',
  'reminder',
] as const;
export type M5MaintenanceOperation = (typeof M5_MAINTENANCE_OPERATIONS)[number];
export const M5_RECEIVER_ACTIONS = ['view', 'accept', 'reject'] as const;
export type M5ReceiverAction = (typeof M5_RECEIVER_ACTIONS)[number];
export const M5_ACTION_OUTCOMES = ['completed', 'replayed', 'closed', 'failure'] as const;
export type M5ActionOutcome = (typeof M5_ACTION_OUTCOMES)[number];
export const M5_RECONCILIATION_PHASES = [
  'flows',
  'counters',
  'pending',
  'delivered',
  'unknown',
] as const;
export type M5ReconciliationPhase = (typeof M5_RECONCILIATION_PHASES)[number];
export const M5_RECONCILIATION_OUTCOMES = ['in_progress', 'completed', 'failure'] as const;
export type M5ReconciliationOutcome = (typeof M5_RECONCILIATION_OUTCOMES)[number];
export const M5_METRIC_LABEL_KEYS = [
  'outcome',
  'funding_type',
  'stop_reason',
  'operation',
  'action',
  'phase',
] as const;

export type M5OperationalHealth = Readonly<{
  settlementBacklogCount: number;
  settlementOldestAgeSeconds: number;
  paidUndeliveredCount: number;
  paidUndeliveredOldestAgeSeconds: number;
  quotaDriftCount: number;
  fundingInvariantMismatchCount: number;
}>;

const meter = metrics.getMeter('nakh-m5');

/** Fixed aggregate labels only. Nakh text, Profile data, user/entity/provider IDs, locale,
 * balances, and raw failure detail are forbidden from every M5 metric. */
export class M5Metrics {
  private readonly creations = meter.createCounter('nakh.m5.creation.count');
  private readonly creationDuration = meter.createHistogram('nakh.m5.creation.duration', {
    unit: 'ms',
  });
  private readonly deliveries = meter.createCounter('nakh.m5.delivery.count');
  private readonly deliveryDuration = meter.createHistogram('nakh.m5.delivery.duration', {
    unit: 'ms',
  });
  private readonly settlementPasses = meter.createCounter('nakh.m5.settlement.passes');
  private readonly settlementDuration = meter.createHistogram('nakh.m5.settlement.duration', {
    unit: 'ms',
  });
  private readonly settlementDelivered = meter.createCounter('nakh.m5.settlement.delivered');
  private readonly settlementClosed = meter.createCounter('nakh.m5.settlement.closed');
  private readonly maintenanceBatches = meter.createCounter('nakh.m5.maintenance.batches');
  private readonly maintenanceDuration = meter.createHistogram('nakh.m5.maintenance.duration', {
    unit: 'ms',
  });
  private readonly maintenanceExamined = meter.createCounter('nakh.m5.maintenance.examined');
  private readonly maintenanceChanged = meter.createCounter('nakh.m5.maintenance.changed');
  private readonly maintenanceFailures = meter.createCounter('nakh.m5.maintenance.failures');
  private readonly receiverActions = meter.createCounter('nakh.m5.receiver_actions.count');
  private readonly receiverActionDuration = meter.createHistogram(
    'nakh.m5.receiver_actions.duration',
    { unit: 'ms' },
  );
  private readonly settlementBacklog = meter.createHistogram('nakh.m5.backlog.settlement_count', {
    unit: '{item}',
  });
  private readonly settlementOldestAge = meter.createHistogram(
    'nakh.m5.backlog.settlement_oldest_age',
    { unit: 's' },
  );
  private readonly paidUndelivered = meter.createHistogram('nakh.m5.backlog.paid_undelivered', {
    unit: '{item}',
  });
  private readonly paidUndeliveredOldestAge = meter.createHistogram(
    'nakh.m5.backlog.paid_undelivered_oldest_age',
    { unit: 's' },
  );
  private readonly quotaDrift = meter.createHistogram('nakh.m5.integrity.quota_drift', {
    unit: '{user}',
  });
  private readonly fundingInvariantMismatch = meter.createHistogram(
    'nakh.m5.integrity.funding_invariant_mismatch',
    { unit: '{item}' },
  );
  private readonly reconciliationBatches = meter.createCounter('nakh.m5.reconciliation.batches');
  private readonly reconciliationDuration = meter.createHistogram(
    'nakh.m5.reconciliation.duration',
    { unit: 'ms' },
  );
  private readonly reconciliationScanned = meter.createCounter('nakh.m5.reconciliation.scanned');
  private readonly reconciliationAnomalies = meter.createCounter(
    'nakh.m5.reconciliation.anomalies',
  );
  private readonly reconciliationFailures = meter.createCounter('nakh.m5.reconciliation.failures');
  private readonly callbackConflicts = meter.createCounter('nakh.m5.callback_conflicts');
  private readonly operationalHealthFailures = meter.createCounter(
    'nakh.m5.operational_health.failures',
  );

  public recordCreation(
    outcome: M5CreationOutcome,
    fundingType: M5FundingType,
    durationMs: number,
  ): void {
    const labels = { outcome, funding_type: fundingType };
    this.creations.add(1, labels);
    this.creationDuration.record(durationMs, labels);
  }

  public recordDelivery(
    outcome: M5DeliveryOutcome,
    fundingType: M5FundingType,
    durationMs: number,
    count = 1,
  ): void {
    const labels = { outcome, funding_type: fundingType };
    this.deliveries.add(count, labels);
    this.deliveryDuration.record(durationMs, labels);
  }

  public recordSettlement(
    stopReason: M5SettlementStopReason,
    durationMs: number,
    deliveredCount = 0,
    closedCount = 0,
  ): void {
    const labels = { stop_reason: stopReason };
    this.settlementPasses.add(1, labels);
    this.settlementDuration.record(durationMs, labels);
    this.settlementDelivered.add(deliveredCount);
    this.settlementClosed.add(closedCount);
  }

  public recordMaintenance(
    operation: M5MaintenanceOperation,
    outcome: 'completed' | 'failure',
    durationMs: number,
    examined = 0,
    changed = 0,
  ): void {
    const labels = { operation, outcome };
    this.maintenanceBatches.add(1, labels);
    this.maintenanceDuration.record(durationMs, labels);
    this.maintenanceExamined.add(examined, { operation });
    this.maintenanceChanged.add(changed, { operation });
    if (outcome === 'failure') this.maintenanceFailures.add(1);
  }

  public recordReceiverAction(
    action: M5ReceiverAction,
    outcome: M5ActionOutcome,
    durationMs: number,
  ): void {
    const labels = { action, outcome };
    this.receiverActions.add(1, labels);
    this.receiverActionDuration.record(durationMs, labels);
  }

  public recordOperationalHealth(health: M5OperationalHealth): void {
    this.settlementBacklog.record(health.settlementBacklogCount);
    this.settlementOldestAge.record(health.settlementOldestAgeSeconds);
    this.paidUndelivered.record(health.paidUndeliveredCount);
    this.paidUndeliveredOldestAge.record(health.paidUndeliveredOldestAgeSeconds);
    this.quotaDrift.record(health.quotaDriftCount);
    this.fundingInvariantMismatch.record(health.fundingInvariantMismatchCount);
  }

  public recordOperationalHealthFailure(): void {
    this.operationalHealthFailures.add(1);
  }

  public recordReconciliation(
    outcome: M5ReconciliationOutcome,
    phase: M5ReconciliationPhase,
    durationMs: number,
    scannedCount = 0,
    anomalyCount = 0,
  ): void {
    const labels = { outcome, phase };
    this.reconciliationBatches.add(1, labels);
    this.reconciliationDuration.record(durationMs, labels);
    this.reconciliationScanned.add(scannedCount, { phase });
    this.reconciliationAnomalies.add(anomalyCount, { phase });
    if (outcome === 'failure') this.reconciliationFailures.add(1);
  }

  public recordCallbackConflict(): void {
    this.callbackConflicts.add(1);
  }
}
