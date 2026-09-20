import { ApplicationError } from '@nakh/domain';
import type {
  ClaimedTelegramLikedByDelivery,
  PostgresTelegramLikedByDeliveryStore,
  TelegramLikedByDeliveryErrorCode,
} from '@nakh/persistence-postgres';
import {
  TelegramLikedBySendFailure,
  type TelegramLikedByPageProcessor,
  type TelegramLockedLikedByScreen,
} from '@nakh/telegram';

type DeliveryStore = Pick<
  PostgresTelegramLikedByDeliveryStore,
  'claimBatch' | 'markDelivered' | 'markFailed' | 'releaseForRetry'
>;
type PageProcessor = Pick<TelegramLikedByPageProcessor, 'execute'>;

export type TelegramLikedBySendInput = Readonly<{
  deliveryId: string;
  owner: string;
  attemptCount: number;
  botId: string;
  viewerUserId: string;
  telegramUserId: string;
  callbackQueryId?: string;
  screen: TelegramLockedLikedByScreen;
}>;

export interface TelegramLikedBySendPort {
  /** Must resume from stable deliveryId after a partial or uncertain Telegram send. */
  send(input: TelegramLikedBySendInput): Promise<void>;
}

export class TelegramLikedByLeaseLost extends Error {
  public constructor() {
    super('Telegram Liked By delivery lease was lost.');
  }
}

export type TelegramLikedByPollResult =
  | Readonly<{ outcome: 'idle' | 'delivered' | 'lease_lost' }>
  | Readonly<{
      outcome: 'retry_scheduled' | 'failed';
      reasonCode: TelegramLikedByDeliveryErrorCode;
    }>;

type Failure = Readonly<{
  reasonCode: TelegramLikedByDeliveryErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
}>;

function classify(error: unknown): Failure {
  if (error instanceof TelegramLikedBySendFailure)
    return {
      reasonCode: error.reasonCode,
      retryable: error.reasonCode !== 'provider_rejected',
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  if (error instanceof ApplicationError) {
    if (error.status === 401 || error.status === 403)
      return { reasonCode: 'identity_unavailable', retryable: false };
    return {
      reasonCode: 'page_unavailable',
      retryable: error.status >= 500 || error.status === 429,
    };
  }
  return { reasonCode: 'unknown_failure', retryable: true };
}

function retryDelay(attemptCount: number, retryAfterMs?: number): number {
  return retryAfterMs ?? Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount - 1, 6));
}

/** One claimed request at a time; no provider call occurs until the page is freshly rebuilt. */
export class TelegramLikedByDeliveryProcessor {
  public constructor(
    private readonly store: DeliveryStore,
    private readonly page: PageProcessor,
    private readonly sender: TelegramLikedBySendPort,
    private readonly owner: string,
  ) {}

  public async processNext(): Promise<TelegramLikedByPollResult> {
    const [delivery] = await this.store.claimBatch({
      owner: this.owner,
      leaseMs: 300_000,
      limit: 1,
    });
    if (delivery === undefined) return { outcome: 'idle' };
    return this.processClaim(delivery);
  }

  private async processClaim(
    delivery: ClaimedTelegramLikedByDelivery,
  ): Promise<TelegramLikedByPollResult> {
    const settlement = {
      id: delivery.id,
      owner: this.owner,
      attemptCount: delivery.attemptCount,
    };
    try {
      const screen = await this.page.execute({
        handled: true,
        kind: 'page_request',
        updateId: delivery.updateId,
        userId: delivery.viewerUserId,
        telegramUserId: delivery.telegramUserId,
        requestId: delivery.requestId,
        ...(delivery.cursor === undefined ? {} : { cursor: delivery.cursor }),
        ...(delivery.callbackQueryId === undefined
          ? {}
          : { callbackQueryId: delivery.callbackQueryId }),
      });
      await this.sender.send({
        deliveryId: delivery.id,
        owner: this.owner,
        attemptCount: delivery.attemptCount,
        botId: delivery.botId,
        viewerUserId: delivery.viewerUserId,
        telegramUserId: delivery.telegramUserId,
        ...(delivery.callbackQueryId === undefined
          ? {}
          : { callbackQueryId: delivery.callbackQueryId }),
        screen,
      });
    } catch (error) {
      if (error instanceof TelegramLikedByLeaseLost) return { outcome: 'lease_lost' };
      const failure = classify(error);
      if (!failure.retryable || delivery.attemptCount >= 5) {
        const reasonCode = failure.retryable ? 'retry_exhausted' : failure.reasonCode;
        const recorded = await this.store.markFailed({ ...settlement, errorCode: reasonCode });
        return recorded ? { outcome: 'failed', reasonCode } : { outcome: 'lease_lost' };
      }
      const recorded = await this.store.releaseForRetry({
        ...settlement,
        errorCode: failure.reasonCode,
        delayMs: retryDelay(delivery.attemptCount, failure.retryAfterMs),
      });
      return recorded
        ? { outcome: 'retry_scheduled', reasonCode: failure.reasonCode }
        : { outcome: 'lease_lost' };
    }
    const recorded = await this.store.markDelivered(settlement);
    return recorded ? { outcome: 'delivered' } : { outcome: 'lease_lost' };
  }
}
