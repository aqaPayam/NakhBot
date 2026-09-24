import type {
  ClaimNotificationDeliveriesCommand,
  ClaimedNotificationDelivery,
  SettleNotificationDeliveryCommand,
} from '@nakh/contracts';
import {
  ApplicationError,
  planNotificationDeliveryFailure,
  type Clock,
  type NotificationProviderFailureCode,
} from '@nakh/domain';

export const NOTIFICATION_DELIVERY_LEASE_MS = 60_000;

export type NotificationDeliveryLease = Readonly<{
  deliveryId: string;
  leaseOwner: string;
  fenceToken: string;
}>;

export type TelegramNotificationProjection = Readonly<{
  deliveryId: string;
  telegramUserId: string;
  locale: string;
  titleKey: string;
  bodyKey: string;
}>;

export type NotificationDeliverySettlementWrite = NotificationDeliveryLease &
  Readonly<{ attemptNumber: number }> &
  (
    | Readonly<{ outcome: 'sent'; providerMessageKey: string }>
    | Readonly<{
        outcome: 'failed_retryable';
        failureCode: NotificationProviderFailureCode | 'retry_exhausted';
        retryDelayMs: number;
      }>
    | Readonly<{
        outcome: 'failed_terminal';
        failureCode: NotificationProviderFailureCode | 'retry_exhausted';
        quarantine: boolean;
      }>
  );

export interface NotificationDeliveryStore {
  claimDue(input: {
    workerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<ClaimedNotificationDelivery[]>;
  loadTelegramProjection(
    lease: NotificationDeliveryLease,
  ): Promise<TelegramNotificationProjection | undefined>;
  markProviderCallStarted(lease: NotificationDeliveryLease): Promise<boolean>;
  settle(write: NotificationDeliverySettlementWrite): Promise<boolean>;
}

function requireSystem(actor: ClaimNotificationDeliveriesCommand['actor']): void {
  if (actor.kind !== 'system')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}

function failureCode(value: string): NotificationProviderFailureCode {
  switch (value) {
    case 'rate_limited':
    case 'provider_unavailable':
    case 'network_error':
    case 'bot_blocked':
    case 'recipient_unavailable':
    case 'provider_request_invalid':
    case 'ambiguous_result':
      return value;
    default:
      throw new ApplicationError(
        'notification_delivery_invalid',
        'error.notification.delivery_state_invalid',
        400,
      );
  }
}

/** Provider-neutral M6 delivery coordinator. Provider calls remain outside this use case. */
export class NotificationDeliveryCoordinator {
  public constructor(
    private readonly store: NotificationDeliveryStore,
    private readonly clock: Clock,
    private readonly jitterRatio: () => number = Math.random,
  ) {}

  public async claim(
    command: ClaimNotificationDeliveriesCommand,
  ): Promise<ClaimedNotificationDelivery[]> {
    requireSystem(command.actor);
    return await this.store.claimDue({
      workerId: command.data.workerId,
      limit: command.data.limit,
      leaseMs: NOTIFICATION_DELIVERY_LEASE_MS,
    });
  }

  public markProviderCallStarted(lease: NotificationDeliveryLease): Promise<boolean> {
    return this.store.markProviderCallStarted(lease);
  }

  public loadTelegramProjection(
    lease: NotificationDeliveryLease,
  ): Promise<TelegramNotificationProjection | undefined> {
    return this.store.loadTelegramProjection(lease);
  }

  public async settle(
    command: SettleNotificationDeliveryCommand,
    attemptNumber: number,
  ): Promise<boolean> {
    requireSystem(command.actor);
    const lease = {
      deliveryId: command.data.deliveryId,
      leaseOwner: command.data.leaseOwner,
      fenceToken: command.data.fenceToken,
      attemptNumber,
    };
    const result = command.data.result;
    if (result.outcome === 'sent')
      return await this.store.settle({
        ...lease,
        outcome: 'sent',
        providerMessageKey: result.providerMessageKey,
      });

    const code = failureCode(result.failureCode);
    const now = this.clock.now();
    const plan = planNotificationDeliveryFailure({
      failureCode: code,
      attemptNumber,
      now,
      jitterRatio: this.jitterRatio(),
      ...(result.outcome === 'failed_retryable' && result.retryAfterMs !== undefined
        ? { retryAfterMs: result.retryAfterMs }
        : {}),
    });
    if (plan.status === 'failed_retryable')
      return await this.store.settle({
        ...lease,
        outcome: 'failed_retryable',
        failureCode: plan.failureCode,
        retryDelayMs: plan.nextAttemptAt.getTime() - now.getTime(),
      });
    return await this.store.settle({
      ...lease,
      outcome: 'failed_terminal',
      failureCode: plan.failureCode,
      quarantine: plan.quarantine,
    });
  }
}
