import { metrics } from '@opentelemetry/api';

export const M6_SEND_KINDS = [
  'predefined_question',
  'predefined_answer',
  'text',
  'system',
] as const;
export type M6SendKind = (typeof M6_SEND_KINDS)[number];
export const M6_SEND_OUTCOMES = ['sent', 'replayed', 'denied', 'failure'] as const;
export type M6SendOutcome = (typeof M6_SEND_OUTCOMES)[number];
export const M6_AUTHORIZATION_DENIALS = [
  'not_participant',
  'session_closed',
  'capability_denied',
  'stale_context',
  'account_ineligible',
  'unsupported_content',
] as const;
export type M6AuthorizationDenial = (typeof M6_AUTHORIZATION_DENIALS)[number];
export const M6_DELIVERY_OUTCOMES = [
  'delivered',
  'retry_scheduled',
  'failed',
  'quarantined',
  'lease_lost',
  'poll_failure',
] as const;
export type M6DeliveryOutcome = (typeof M6_DELIVERY_OUTCOMES)[number];
export const M6_RETRY_CLASSES = [
  'none',
  'rate_limited',
  'transient',
  'terminal',
  'ambiguous',
  'exhausted',
] as const;
export type M6RetryClass = (typeof M6_RETRY_CLASSES)[number];
export const M6_CLEANUP_OUTCOMES = ['completed', 'failure'] as const;
export type M6CleanupOutcome = (typeof M6_CLEANUP_OUTCOMES)[number];
export const M6_RECONCILIATION_PHASES = [
  'sessions',
  'messages',
  'unmatches',
  'deliveries',
  'unknown',
] as const;
export type M6ReconciliationPhase = (typeof M6_RECONCILIATION_PHASES)[number];
export const M6_RECONCILIATION_OUTCOMES = ['in_progress', 'completed', 'failure'] as const;
export type M6ReconciliationOutcome = (typeof M6_RECONCILIATION_OUTCOMES)[number];
export const M6_UNMATCH_OUTCOMES = ['completed', 'replayed', 'denied', 'failure'] as const;
export type M6UnmatchOutcome = (typeof M6_UNMATCH_OUTCOMES)[number];
export const M6_METRIC_LABEL_KEYS = ['kind', 'outcome', 'denial', 'retry_class', 'phase'] as const;

export type M6OperationalHealth = Readonly<{
  dueDeliveryCount: number;
  dueDeliveryOldestAgeSeconds: number;
  expiredCallLeaseCount: number;
  expiredCallLeaseOldestAgeSeconds: number;
  cleanupBacklogSessionCount: number;
  cleanupBacklogMessageCount: number;
  cleanupBacklogOldestAgeSeconds: number;
  pendingSnapshotCount: number;
  pendingSnapshotOldestAgeSeconds: number;
  participantMismatchCount: number;
  sequenceIntegrityCount: number;
  deliveryIntegrityCount: number;
}>;

const meter = metrics.getMeter('nakh-m6');

/** Fixed aggregate dimensions only. User/session/message/provider IDs, message/snapshot content,
 * locale, raw error codes, and provider responses are forbidden from every M6 metric. */
export class M6Metrics {
  private readonly sends = meter.createCounter('nakh.m6.chat.send.count');
  private readonly sendDuration = meter.createHistogram('nakh.m6.chat.send.duration', {
    unit: 'ms',
  });
  private readonly authorizationDenials = meter.createCounter('nakh.m6.chat.authorization_denials');
  private readonly deliveries = meter.createCounter('nakh.m6.delivery.count');
  private readonly deliveryDuration = meter.createHistogram('nakh.m6.delivery.duration', {
    unit: 'ms',
  });
  private readonly cleanupBatches = meter.createCounter('nakh.m6.cleanup.batches');
  private readonly cleanupDuration = meter.createHistogram('nakh.m6.cleanup.duration', {
    unit: 'ms',
  });
  private readonly cleanupExamined = meter.createCounter('nakh.m6.cleanup.examined');
  private readonly cleanupDeleted = meter.createCounter('nakh.m6.cleanup.deleted');
  private readonly cleanupSnapshots = meter.createCounter('nakh.m6.cleanup.snapshots');
  private readonly reconciliationBatches = meter.createCounter('nakh.m6.reconciliation.batches');
  private readonly reconciliationDuration = meter.createHistogram(
    'nakh.m6.reconciliation.duration',
    { unit: 'ms' },
  );
  private readonly reconciliationScanned = meter.createCounter('nakh.m6.reconciliation.scanned');
  private readonly reconciliationAnomalies = meter.createCounter(
    'nakh.m6.reconciliation.anomalies',
  );
  private readonly unmatches = meter.createCounter('nakh.m6.unmatch.count');
  private readonly dueDeliveryCount = meter.createHistogram('nakh.m6.backlog.delivery_due', {
    unit: '{item}',
  });
  private readonly dueDeliveryOldestAge = meter.createHistogram(
    'nakh.m6.backlog.delivery_due_oldest_age',
    { unit: 's' },
  );
  private readonly expiredCallLeaseCount = meter.createHistogram(
    'nakh.m6.backlog.expired_call_lease',
    { unit: '{item}' },
  );
  private readonly expiredCallLeaseOldestAge = meter.createHistogram(
    'nakh.m6.backlog.expired_call_lease_oldest_age',
    { unit: 's' },
  );
  private readonly cleanupBacklogSessions = meter.createHistogram(
    'nakh.m6.backlog.cleanup_sessions',
    { unit: '{session}' },
  );
  private readonly cleanupBacklogMessages = meter.createHistogram(
    'nakh.m6.backlog.cleanup_messages',
    { unit: '{message}' },
  );
  private readonly cleanupBacklogOldestAge = meter.createHistogram(
    'nakh.m6.backlog.cleanup_oldest_age',
    { unit: 's' },
  );
  private readonly pendingSnapshots = meter.createHistogram('nakh.m6.backlog.pending_snapshots', {
    unit: '{snapshot}',
  });
  private readonly pendingSnapshotOldestAge = meter.createHistogram(
    'nakh.m6.backlog.pending_snapshot_oldest_age',
    { unit: 's' },
  );
  private readonly participantMismatch = meter.createHistogram(
    'nakh.m6.integrity.participant_mismatch',
    { unit: '{item}' },
  );
  private readonly sequenceIntegrity = meter.createHistogram(
    'nakh.m6.integrity.sequence_anomalies',
    { unit: '{item}' },
  );
  private readonly deliveryIntegrity = meter.createHistogram(
    'nakh.m6.integrity.delivery_anomalies',
    { unit: '{item}' },
  );
  private readonly operationalHealthFailures = meter.createCounter(
    'nakh.m6.operational_health.failures',
  );

  public recordSend(kind: M6SendKind, outcome: M6SendOutcome, durationMs: number): void {
    const labels = { kind, outcome };
    this.sends.add(1, labels);
    this.sendDuration.record(durationMs, labels);
  }

  public recordAuthorizationDenial(denial: M6AuthorizationDenial): void {
    this.authorizationDenials.add(1, { denial });
  }

  public recordDelivery(
    outcome: M6DeliveryOutcome,
    retryClass: M6RetryClass,
    durationMs: number,
  ): void {
    const labels = { outcome, retry_class: retryClass };
    this.deliveries.add(1, labels);
    this.deliveryDuration.record(durationMs, labels);
  }

  public recordCleanup(
    outcome: M6CleanupOutcome,
    durationMs: number,
    examinedCount = 0,
    deletedCount = 0,
    snapshotCount = 0,
  ): void {
    this.cleanupBatches.add(1, { outcome });
    this.cleanupDuration.record(durationMs, { outcome });
    this.cleanupExamined.add(examinedCount);
    this.cleanupDeleted.add(deletedCount);
    this.cleanupSnapshots.add(snapshotCount);
  }

  public recordReconciliation(
    outcome: M6ReconciliationOutcome,
    phase: M6ReconciliationPhase,
    durationMs: number,
    scannedCount = 0,
    anomalyCount = 0,
  ): void {
    const labels = { outcome, phase };
    this.reconciliationBatches.add(1, labels);
    this.reconciliationDuration.record(durationMs, labels);
    this.reconciliationScanned.add(scannedCount, { phase });
    this.reconciliationAnomalies.add(anomalyCount, { phase });
  }

  public recordUnmatch(outcome: M6UnmatchOutcome): void {
    this.unmatches.add(1, { outcome });
  }

  public recordOperationalHealth(health: M6OperationalHealth): void {
    this.dueDeliveryCount.record(health.dueDeliveryCount);
    this.dueDeliveryOldestAge.record(health.dueDeliveryOldestAgeSeconds);
    this.expiredCallLeaseCount.record(health.expiredCallLeaseCount);
    this.expiredCallLeaseOldestAge.record(health.expiredCallLeaseOldestAgeSeconds);
    this.cleanupBacklogSessions.record(health.cleanupBacklogSessionCount);
    this.cleanupBacklogMessages.record(health.cleanupBacklogMessageCount);
    this.cleanupBacklogOldestAge.record(health.cleanupBacklogOldestAgeSeconds);
    this.pendingSnapshots.record(health.pendingSnapshotCount);
    this.pendingSnapshotOldestAge.record(health.pendingSnapshotOldestAgeSeconds);
    this.participantMismatch.record(health.participantMismatchCount);
    this.sequenceIntegrity.record(health.sequenceIntegrityCount);
    this.deliveryIntegrity.record(health.deliveryIntegrityCount);
  }

  public recordOperationalHealthFailure(): void {
    this.operationalHealthFailures.add(1);
  }
}

/** Maps raw provider/application reasons into a finite metric dimension. */
export function m6RetryClass(reasonCode: string | undefined): M6RetryClass {
  switch (reasonCode) {
    case undefined:
      return 'none';
    case 'rate_limited':
      return 'rate_limited';
    case 'provider_unavailable':
    case 'network_error':
      return 'transient';
    case 'bot_blocked':
    case 'recipient_unavailable':
    case 'provider_request_invalid':
      return 'terminal';
    case 'ambiguous_result':
      return 'ambiguous';
    case 'retry_exhausted':
      return 'exhausted';
    default:
      return 'transient';
  }
}
