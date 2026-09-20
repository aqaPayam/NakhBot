import { metrics } from '@opentelemetry/api';

export const M3_TELEGRAM_INGRESS_OUTCOMES = [
  'enqueued',
  'replayed',
  'notice',
  'rejected',
  'failure',
] as const;
export type M3TelegramIngressOutcome = (typeof M3_TELEGRAM_INGRESS_OUTCOMES)[number];

export const M3_TELEGRAM_DELIVERY_OUTCOMES = [
  'delivered',
  'retry_scheduled',
  'failed',
  'lease_lost',
  'poll_failure',
] as const;
export type M3TelegramDeliveryOutcome = (typeof M3_TELEGRAM_DELIVERY_OUTCOMES)[number];

export const M3_TELEGRAM_REASON_CODES = [
  'none',
  'identity_unavailable',
  'page_unavailable',
  'media_unavailable',
  'provider_timeout',
  'provider_rejected',
  'provider_unavailable',
  'retry_exhausted',
  'unknown_failure',
  'rate_limited',
  'unauthorized',
  'invalid_request',
  'idempotency_conflict',
  'internal_error',
] as const;
export type M3TelegramReasonCode = (typeof M3_TELEGRAM_REASON_CODES)[number];

export const M3_METRIC_LABEL_KEYS = ['outcome', 'reason_code'] as const;

const meter = metrics.getMeter('nakh-m3');

/** Only finite outcome and reason registries are accepted as attributes. IDs, cursors,
 * provider details, URLs, locale, and user data must never be supplied to these metrics. */
export class M3Metrics {
  private readonly ingress = meter.createCounter('nakh.m3.telegram.ingress.count');
  private readonly ingressDuration = meter.createHistogram('nakh.m3.telegram.ingress.duration', {
    unit: 'ms',
  });
  private readonly ingressFailures = meter.createCounter('nakh.m3.telegram.ingress.failures');
  private readonly delivery = meter.createCounter('nakh.m3.telegram.delivery.count');
  private readonly deliveryDuration = meter.createHistogram('nakh.m3.telegram.delivery.duration', {
    unit: 'ms',
  });
  private readonly deliveryFailures = meter.createCounter('nakh.m3.telegram.delivery.failures');
  private readonly deliveryRetries = meter.createCounter('nakh.m3.telegram.delivery.retries');
  private readonly leaseLosses = meter.createCounter('nakh.m3.telegram.delivery.lease_losses');
  private readonly backlogPending = meter.createHistogram('nakh.m3.telegram.backlog.pending', {
    unit: '{request}',
  });
  private readonly backlogOldestAge = meter.createHistogram('nakh.m3.telegram.backlog.oldest_age', {
    unit: 's',
  });
  private readonly backlogFailures = meter.createCounter('nakh.m3.telegram.backlog.failures');

  public recordTelegramIngress(
    outcome: M3TelegramIngressOutcome,
    durationMs: number,
    reasonCode: M3TelegramReasonCode = 'none',
  ): void {
    const labels = { outcome, reason_code: reasonCode };
    this.ingress.add(1, labels);
    this.ingressDuration.record(durationMs, labels);
    if (outcome === 'rejected' || outcome === 'failure') this.ingressFailures.add(1);
  }

  public recordTelegramDelivery(
    outcome: M3TelegramDeliveryOutcome,
    durationMs: number,
    reasonCode: M3TelegramReasonCode = 'none',
  ): void {
    const labels = { outcome, reason_code: reasonCode };
    this.delivery.add(1, labels);
    this.deliveryDuration.record(durationMs, labels);
    if (outcome === 'retry_scheduled') this.deliveryRetries.add(1);
    if (outcome === 'failed' || outcome === 'poll_failure') this.deliveryFailures.add(1);
    if (outcome === 'lease_lost') this.leaseLosses.add(1);
  }

  public recordTelegramBacklog(pendingCount: number, oldestAgeSeconds: number): void {
    this.backlogPending.record(pendingCount);
    this.backlogOldestAge.record(oldestAgeSeconds);
  }

  public recordTelegramBacklogFailure(): void {
    this.backlogFailures.add(1);
  }
}
