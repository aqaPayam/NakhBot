export type StarsRefundLease = Readonly<{
  refundRecordId: string;
  owner: string;
  fenceToken: bigint;
}>;

export type ClaimedStarsRefund = StarsRefundLease &
  Readonly<{
    paymentRecordId: string;
    userId: string;
    telegramChargeId: string;
    starsAmount: bigint;
    attemptCount: number;
  }>;

export type StarsRefundProviderResult =
  | Readonly<{ outcome: 'succeeded' }>
  | Readonly<{
      outcome: 'retryable_not_sent' | 'ambiguous' | 'terminal_failure';
      errorCode: string;
    }>;

export type StarsRefundFailure = StarsRefundLease &
  Readonly<{
    kind: 'retryable_not_sent' | 'ambiguous' | 'terminal_failure';
    errorCode: string;
    delayMs?: number;
  }>;

export type StarsRefundCompletion = 'processed' | 'replayed' | 'lease_lost';

export interface StarsRefundStore {
  beginProviderCall(lease: StarsRefundLease): Promise<boolean>;
  completeStarsRefund(lease: StarsRefundLease): Promise<StarsRefundCompletion>;
  recordProviderFailure(failure: StarsRefundFailure): Promise<boolean>;
}

export interface TelegramStarsRefundProvider {
  refund(
    input: Readonly<{
      refundRecordId: string;
      telegramChargeId: string;
      starsAmount: bigint;
    }>,
  ): Promise<StarsRefundProviderResult>;
}

export type AmbiguousStarsRefundResolution = Readonly<{
  actor: Actor;
  refundRecordId: string;
  observedOutcome: 'refunded' | 'not_refunded' | 'terminal_failure';
  evidenceDigest: string;
  requestId: string;
  commandId: string;
  auditId: string;
  eventId: string;
}>;

export type AmbiguousStarsRefundResolutionResult = Readonly<{
  outcome: 'corrected' | 'retry_scheduled' | 'terminal_failure';
  replayed: boolean;
}>;

export interface AmbiguousStarsRefundResolutionStore {
  resolveAmbiguousStarsRefund(
    input: AmbiguousStarsRefundResolution,
  ): Promise<AmbiguousStarsRefundResolutionResult>;
}

/** Requires an authenticated admin; the store validates active operator membership and evidence. */
export class ResolveAmbiguousStarsRefundHandler {
  public constructor(private readonly store: AmbiguousStarsRefundResolutionStore) {}

  public execute(
    input: AmbiguousStarsRefundResolution,
  ): Promise<AmbiguousStarsRefundResolutionResult> {
    if (input.actor.kind !== 'admin')
      throw new ApplicationError('forbidden', 'error.billing.refund_resolution_forbidden', 403);
    return this.store.resolveAmbiguousStarsRefund(input);
  }
}

export type ProcessStarsRefundResult = Readonly<{
  outcome:
    | 'processed'
    | 'replayed'
    | 'retryable'
    | 'reconciliation_required'
    | 'terminal_failure'
    | 'lease_lost';
}>;

/**
 * Persists call_started before invoking Telegram. An unknown provider outcome is quarantined for
 * reconciliation and is never converted back into a normally claimable refund.
 */
export class ProcessTelegramStarsRefundHandler {
  public constructor(
    private readonly store: StarsRefundStore,
    private readonly provider: TelegramStarsRefundProvider,
    private readonly retryDelayMs = 60_000,
  ) {}

  public async execute(refund: ClaimedStarsRefund): Promise<ProcessStarsRefundResult> {
    if (!(await this.store.beginProviderCall(refund))) return { outcome: 'lease_lost' };

    let providerResult: StarsRefundProviderResult;
    try {
      providerResult = await this.provider.refund({
        refundRecordId: refund.refundRecordId,
        telegramChargeId: refund.telegramChargeId,
        starsAmount: refund.starsAmount,
      });
    } catch {
      const recorded = await this.store.recordProviderFailure({
        ...refund,
        kind: 'ambiguous',
        errorCode: 'provider_outcome_unknown',
      });
      return { outcome: recorded ? 'reconciliation_required' : 'lease_lost' };
    }

    if (providerResult.outcome === 'succeeded') {
      const completion = await this.store.completeStarsRefund(refund);
      return {
        outcome: completion === 'lease_lost' ? 'reconciliation_required' : completion,
      };
    }

    const recorded = await this.store.recordProviderFailure({
      ...refund,
      kind: providerResult.outcome,
      errorCode: providerResult.errorCode,
      ...(providerResult.outcome === 'retryable_not_sent' ? { delayMs: this.retryDelayMs } : {}),
    });
    if (!recorded) return { outcome: 'lease_lost' };
    if (providerResult.outcome === 'retryable_not_sent') return { outcome: 'retryable' };
    if (providerResult.outcome === 'terminal_failure') return { outcome: 'terminal_failure' };
    return { outcome: 'reconciliation_required' };
  }
}
import { ApplicationError, type Actor } from '@nakh/domain';
