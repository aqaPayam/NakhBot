import { metrics } from '@opentelemetry/api';

export const M1_HANDLER_OPERATIONS = [
  'first_start',
  'settings_update',
  'signup_start',
  'signup_step',
  'signup_confirm',
  'profile_update',
  'guest_preview_consume',
  'protected_change_request',
  'protected_change_review',
] as const;
export type M1HandlerOperation = (typeof M1_HANDLER_OPERATIONS)[number];

export const M1_OUTCOMES = ['success', 'replay', 'denied', 'conflict', 'failure'] as const;
export type M1Outcome = (typeof M1_OUTCOMES)[number];

export const M1_REASON_CODES = [
  'none',
  'unauthorized',
  'capability_denied',
  'idempotency_conflict',
  'version_conflict',
  'invalid_request',
  'inactive_catalog_selection',
  'profile_incomplete',
  'media_not_eligible',
  'guest_preview_limit_reached',
  'rate_limited',
  'pending_profile_change_exists',
  'profile_change_invalid',
  'reviewer_unauthorized',
  'dependency_unavailable',
  'internal_error',
] as const;
export type M1ReasonCode = (typeof M1_REASON_CODES)[number];

export const M1_METRIC_LABEL_KEYS = ['operation', 'outcome', 'reason_code', 'stage'] as const;

const meter = metrics.getMeter('nakh-m1');

export class M1Metrics {
  private readonly handlerCount = meter.createCounter('nakh.m1.handler.count');
  private readonly handlerDuration = meter.createHistogram('nakh.m1.handler.duration', {
    unit: 'ms',
  });
  private readonly signupCount = meter.createCounter('nakh.m1.signup.count');
  private readonly profileCompletionCount = meter.createCounter(
    'nakh.m1.profile.completion_transition.count',
  );
  private readonly guestPreviewCount = meter.createCounter('nakh.m1.guest_preview.count');
  private readonly protectedChangeCount = meter.createCounter('nakh.m1.protected_change.count');
  private readonly outboxLag = meter.createHistogram('nakh.m1.outbox.unpublished_age', {
    unit: 's',
  });

  public recordHandler(
    operation: M1HandlerOperation,
    outcome: M1Outcome,
    durationMs: number,
    reasonCode: M1ReasonCode = 'none',
  ): void {
    const attributes = { operation, outcome, reason_code: reasonCode };
    this.handlerCount.add(1, attributes);
    this.handlerDuration.record(durationMs, attributes);
  }

  public recordSignup(
    stage: 'started' | 'completed' | 'failed',
    reasonCode: M1ReasonCode = 'none',
  ): void {
    this.signupCount.add(1, { stage, reason_code: reasonCode });
  }

  public recordProfileCompletion(stage: 'invalidated' | 'restored'): void {
    this.profileCompletionCount.add(1, { stage });
  }

  public recordGuestPreview(stage: 'consumed' | 'denied'): void {
    this.guestPreviewCount.add(1, { stage });
  }

  public recordProtectedChange(stage: 'requested' | 'approved' | 'rejected' | 'conflict'): void {
    this.protectedChangeCount.add(1, { stage });
  }

  public recordOutboxUnpublishedAge(seconds: number): void {
    this.outboxLag.record(seconds);
  }
}
