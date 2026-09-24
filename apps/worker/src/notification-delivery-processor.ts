import { randomUUID } from 'node:crypto';

import type {
  NotificationDeliveryCoordinator,
  TelegramNotificationProjection,
} from '@nakh/application';
import type { ClaimedNotificationDelivery } from '@nakh/contracts';
import { TelegramNotificationSendFailure, type TelegramNotificationSender } from '@nakh/telegram';

type Coordinator = Pick<
  NotificationDeliveryCoordinator,
  'claim' | 'loadTelegramProjection' | 'markProviderCallStarted' | 'settle'
>;
type Sender = Pick<TelegramNotificationSender, 'send'>;

export interface NotificationRendererPort {
  render(
    projection: TelegramNotificationProjection,
  ): Promise<Readonly<{ title: string; body: string }>>;
}

export type NotificationDeliveryPollResult =
  | Readonly<{ outcome: 'idle' | 'delivered' | 'lease_lost' }>
  | Readonly<{
      outcome: 'retry_scheduled' | 'failed' | 'quarantined';
      reasonCode: string;
    }>;

const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';
type SystemCommandEnvelope = Readonly<{
  commandId: string;
  schemaVersion: 1;
  actor: Readonly<{ kind: 'system'; userId: string }>;
  requestId: string;
  idempotencyKey: string;
  occurredAt: string;
  locale: string;
}>;

/** Claims one delivery, renders it just in time, and settles only under its exact fence. */
export class NotificationDeliveryProcessor {
  public constructor(
    private readonly coordinator: Coordinator,
    private readonly renderer: NotificationRendererPort,
    private readonly sender: Sender,
    private readonly owner: string,
    private readonly uuid: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async processNext(): Promise<NotificationDeliveryPollResult> {
    const [claim] = await this.coordinator.claim({
      ...this.envelope('notification.claim-deliveries'),
      commandType: 'notification.claim-deliveries',
      data: { workerId: this.owner, limit: 1 },
    });
    if (claim === undefined) return { outcome: 'idle' };
    return this.processClaim(claim);
  }

  private async processClaim(
    claim: ClaimedNotificationDelivery,
  ): Promise<NotificationDeliveryPollResult> {
    const lease = {
      deliveryId: claim.deliveryId,
      leaseOwner: this.owner,
      fenceToken: claim.fenceToken,
    };
    const projection = await this.coordinator.loadTelegramProjection(lease);
    if (projection === undefined)
      return this.settle(claim, {
        outcome: 'failed_terminal',
        failureCode: 'recipient_unavailable',
      });

    let rendered: Readonly<{ title: string; body: string }>;
    try {
      rendered = await this.renderer.render(projection);
    } catch {
      return this.settle(claim, {
        outcome: 'failed_retryable',
        failureCode: 'provider_unavailable',
      });
    }

    if (!(await this.coordinator.markProviderCallStarted(lease))) return { outcome: 'lease_lost' };
    try {
      const sent = await this.sender.send({
        telegramUserId: projection.telegramUserId,
        title: rendered.title,
        body: rendered.body,
      });
      return this.settle(claim, {
        outcome: 'sent',
        providerMessageKey: sent.providerMessageKey,
      });
    } catch (error) {
      if (!(error instanceof TelegramNotificationSendFailure))
        return this.settle(claim, {
          outcome: 'ambiguous',
          failureCode: 'ambiguous_result',
        });
      if (error.reasonCode === 'ambiguous_result')
        return this.settle(claim, {
          outcome: 'ambiguous',
          failureCode: 'ambiguous_result',
        });
      if (
        error.reasonCode === 'bot_blocked' ||
        error.reasonCode === 'recipient_unavailable' ||
        error.reasonCode === 'provider_request_invalid'
      )
        return this.settle(claim, {
          outcome: 'failed_terminal',
          failureCode: error.reasonCode,
        });
      return this.settle(claim, {
        outcome: 'failed_retryable',
        failureCode: error.reasonCode,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      });
    }
  }

  private async settle(
    claim: ClaimedNotificationDelivery,
    result:
      | Readonly<{ outcome: 'sent'; providerMessageKey: string }>
      | Readonly<{
          outcome: 'failed_retryable';
          failureCode: string;
          retryAfterMs?: number;
        }>
      | Readonly<{ outcome: 'failed_terminal'; failureCode: string }>
      | Readonly<{ outcome: 'ambiguous'; failureCode: 'ambiguous_result' }>,
  ): Promise<NotificationDeliveryPollResult> {
    const recorded = await this.coordinator.settle(
      {
        ...this.envelope('notification.settle-delivery'),
        commandType: 'notification.settle-delivery',
        data: {
          deliveryId: claim.deliveryId,
          leaseOwner: this.owner,
          fenceToken: claim.fenceToken,
          result,
        },
      },
      claim.attemptNumber,
    );
    if (!recorded) return { outcome: 'lease_lost' };
    switch (result.outcome) {
      case 'sent':
        return { outcome: 'delivered' };
      case 'failed_retryable':
        return { outcome: 'retry_scheduled', reasonCode: result.failureCode };
      case 'failed_terminal':
        return { outcome: 'failed', reasonCode: result.failureCode };
      case 'ambiguous':
        return { outcome: 'quarantined', reasonCode: result.failureCode };
    }
  }

  private envelope(commandType: string): SystemCommandEnvelope {
    const commandId = this.uuid();
    return {
      commandId,
      schemaVersion: 1 as const,
      actor: { kind: 'system' as const, userId: SYSTEM_ACTOR_ID },
      requestId: this.uuid(),
      idempotencyKey: `${commandType}:${commandId}`,
      occurredAt: this.now().toISOString(),
      locale: 'en',
    };
  }
}
