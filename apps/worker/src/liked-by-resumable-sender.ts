import { createHash } from 'node:crypto';

import type { LocalizedIntent } from '@nakh/application';
import type { PostgresTelegramLikedByDeliveryStore } from '@nakh/persistence-postgres';
import type { TelegramLockedLikedByMediaRelay, TelegramLockedLikedByScreen } from '@nakh/telegram';

import {
  TelegramLikedByLeaseLost,
  type TelegramLikedBySendInput,
  type TelegramLikedBySendPort,
} from './liked-by-delivery-processor.js';

type Render = (intent: LocalizedIntent) => string;
type ReceiptStore = Pick<
  PostgresTelegramLikedByDeliveryStore,
  'loadRecordedMessageKeys' | 'recordMessageReceipt'
>;
type CardRelay = Pick<TelegramLockedLikedByMediaRelay, 'sendCard'>;

export interface TelegramLikedByRendererProvider {
  rendererFor(viewerUserId: string): Promise<Render>;
}

export interface TelegramLikedByScreenRelay {
  sendScreen(
    input: Readonly<{
      botId: string;
      telegramUserId: string;
      screen: TelegramLockedLikedByScreen;
      render: Render;
    }>,
  ): Promise<number>;
}

function canonicalIntent(intent: LocalizedIntent | undefined): unknown {
  if (intent === undefined) return null;
  return [
    intent.key,
    Object.entries(intent.variables).sort(([left], [right]) => left.localeCompare(right)),
    intent.fallbackKey ?? null,
  ];
}

function screenMessageKey(deliveryId: string, screen: TelegramLockedLikedByScreen): string {
  const digest = createHash('sha256')
    .update('telegram-liked-by-screen-v1\0')
    .update(deliveryId)
    .update('\0')
    .update(
      JSON.stringify([
        canonicalIntent(screen.title),
        canonicalIntent(screen.emptyState),
        screen.nextPage === undefined
          ? null
          : [canonicalIntent(screen.nextPage.label), screen.nextPage.callbackData],
      ]),
    )
    .digest('base64url');
  return `screen:${digest}`;
}

/** Resumes only known provider successes; uncertain sends remain governed by at-least-once policy. */
export class ResumableTelegramLikedBySender implements TelegramLikedBySendPort {
  public constructor(
    private readonly receipts: ReceiptStore,
    private readonly renderers: TelegramLikedByRendererProvider,
    private readonly screens: TelegramLikedByScreenRelay,
    private readonly cards: CardRelay,
  ) {}

  public async send(input: TelegramLikedBySendInput): Promise<void> {
    const settlement = {
      id: input.deliveryId,
      owner: input.owner,
      attemptCount: input.attemptCount,
    };
    const recorded = await this.receipts.loadRecordedMessageKeys(settlement);
    if (recorded === undefined) throw new TelegramLikedByLeaseLost();
    const known = new Set(recorded);
    const screenKey = screenMessageKey(input.deliveryId, input.screen);
    const pendingCards = input.screen.cards.filter(
      (card) => !known.has(`card:${card.unlock.callbackData}`),
    );
    if (known.has(screenKey) && pendingCards.length === 0) return;
    const render = await this.renderers.rendererFor(input.viewerUserId);
    if (!known.has(screenKey)) {
      const providerMessageId = await this.screens.sendScreen({
        botId: input.botId,
        telegramUserId: input.telegramUserId,
        screen: input.screen,
        render,
      });
      await this.record(settlement, screenKey, providerMessageId);
    }
    for (const card of pendingCards) {
      const messageKey = `card:${card.unlock.callbackData}`;
      const providerMessageId = await this.cards.sendCard(
        input.viewerUserId,
        input.telegramUserId,
        card,
        render,
      );
      await this.record(settlement, messageKey, providerMessageId);
    }
  }

  private async record(
    settlement: Readonly<{ id: string; owner: string; attemptCount: number }>,
    messageKey: string,
    providerMessageId: number,
  ): Promise<void> {
    const result = await this.receipts.recordMessageReceipt({
      ...settlement,
      messageKey,
      providerMessageId,
    });
    if (result.outcome === 'lease_lost') throw new TelegramLikedByLeaseLost();
  }
}
