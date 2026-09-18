import { ApplicationError } from '@nakh/domain';
import type { ClaimedTelegramLikedByDelivery } from '@nakh/persistence-postgres';
import type { TelegramLockedLikedByScreen } from '@nakh/telegram';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  TelegramLikedByDeliveryProcessor,
  TelegramLikedBySendFailure,
} from './liked-by-delivery-processor.js';

const delivery: ClaimedTelegramLikedByDelivery = {
  id: '10000000-0000-4000-8000-000000000000',
  botId: '123',
  updateId: '456',
  viewerUserId: '20000000-0000-4000-8000-000000000000',
  telegramUserId: '789',
  requestId: '30000000-0000-4000-8000-000000000000',
  attemptCount: 1,
};
const screen: TelegramLockedLikedByScreen = {
  title: { key: 'liked_by.title', variables: { count: 0 } },
  emptyState: { key: 'liked_by.empty', variables: {} },
  cards: [],
};

type Fixture = Readonly<{
  processor: TelegramLikedByDeliveryProcessor;
  store: Readonly<{
    claimBatch: Mock;
    markDelivered: Mock;
    markFailed: Mock;
    releaseForRetry: Mock;
  }>;
  page: Readonly<{ execute: Mock }>;
  sender: Readonly<{ send: Mock }>;
}>;

function fixture(claimed: ClaimedTelegramLikedByDelivery | null = delivery): Fixture {
  const store = {
    claimBatch: vi.fn().mockResolvedValue(claimed === null ? [] : [claimed]),
    markDelivered: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
    releaseForRetry: vi.fn().mockResolvedValue(true),
  };
  const page = { execute: vi.fn().mockResolvedValue(screen) };
  const sender = { send: vi.fn().mockResolvedValue(undefined) };
  const processor = new TelegramLikedByDeliveryProcessor(store, page, sender, 'sender-one');
  return { processor, store, page, sender };
}

describe('Telegram Liked By delivery processor', () => {
  it('does no work when no request is due', async () => {
    const { processor, store, page, sender } = fixture(null);
    expect(await processor.processNext()).toEqual({ outcome: 'idle' });
    expect(store.claimBatch).toHaveBeenCalledWith({
      owner: 'sender-one',
      leaseMs: 300_000,
      limit: 1,
    });
    expect(page.execute).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('renders after the claim and settles only after a successful send', async () => {
    const { processor, store, page, sender } = fixture({
      ...delivery,
      cursor: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba',
      callbackQueryId: 'callback-one',
    });
    expect(await processor.processNext()).toEqual({ outcome: 'delivered' });
    expect(page.execute).toHaveBeenCalledWith({
      handled: true,
      kind: 'page_request',
      updateId: delivery.updateId,
      userId: delivery.viewerUserId,
      telegramUserId: delivery.telegramUserId,
      requestId: delivery.requestId,
      cursor: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba',
      callbackQueryId: 'callback-one',
    });
    expect(sender.send).toHaveBeenCalledWith({
      deliveryId: delivery.id,
      botId: delivery.botId,
      viewerUserId: delivery.viewerUserId,
      telegramUserId: delivery.telegramUserId,
      callbackQueryId: 'callback-one',
      screen,
    });
    expect(store.markDelivered).toHaveBeenCalledWith({
      id: delivery.id,
      owner: 'sender-one',
      attemptCount: 1,
    });
    expect(page.execute.mock.invocationCallOrder[0]).toBeLessThan(
      sender.send.mock.invocationCallOrder[0]!,
    );
    expect(sender.send.mock.invocationCallOrder[0]).toBeLessThan(
      store.markDelivered.mock.invocationCallOrder[0]!,
    );
  });

  it('retries provider failure using its bounded retry-after delay', async () => {
    const { processor, store, sender } = fixture();
    sender.send.mockRejectedValue(new TelegramLikedBySendFailure('provider_unavailable', 7_000));
    expect(await processor.processNext()).toEqual({
      outcome: 'retry_scheduled',
      reasonCode: 'provider_unavailable',
    });
    expect(store.releaseForRetry).toHaveBeenCalledWith({
      id: delivery.id,
      owner: 'sender-one',
      attemptCount: 1,
      errorCode: 'provider_unavailable',
      delayMs: 7_000,
    });
    expect(store.markDelivered).not.toHaveBeenCalled();
  });

  it('fails a denied page without sending or retrying', async () => {
    const { processor, store, page, sender } = fixture();
    page.execute.mockRejectedValue(
      new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
    );
    expect(await processor.processNext()).toEqual({
      outcome: 'failed',
      reasonCode: 'identity_unavailable',
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalledWith({
      id: delivery.id,
      owner: 'sender-one',
      attemptCount: 1,
      errorCode: 'identity_unavailable',
    });
  });

  it('treats a rejected Telegram recipient as a terminal delivery failure', async () => {
    const { processor, store, sender } = fixture();
    sender.send.mockRejectedValue(new TelegramLikedBySendFailure('provider_rejected'));
    expect(await processor.processNext()).toEqual({
      outcome: 'failed',
      reasonCode: 'provider_rejected',
    });
    expect(store.markFailed).toHaveBeenCalledWith({
      id: delivery.id,
      owner: 'sender-one',
      attemptCount: 1,
      errorCode: 'provider_rejected',
    });
    expect(store.releaseForRetry).not.toHaveBeenCalled();
  });

  it('stops an unknown failure after the bounded final attempt', async () => {
    const { processor, store, sender } = fixture({ ...delivery, attemptCount: 5 });
    sender.send.mockRejectedValue(new Error('provider body containing sensitive details'));
    expect(await processor.processNext()).toEqual({
      outcome: 'failed',
      reasonCode: 'retry_exhausted',
    });
    expect(store.markFailed).toHaveBeenCalledWith({
      id: delivery.id,
      owner: 'sender-one',
      attemptCount: 5,
      errorCode: 'retry_exhausted',
    });
    expect(JSON.stringify(store.markFailed.mock.calls)).not.toContain('sensitive details');
  });

  it('reports a lost settlement lease instead of claiming successful delivery', async () => {
    const { processor, store } = fixture();
    store.markDelivered.mockResolvedValue(false);
    expect(await processor.processNext()).toEqual({ outcome: 'lease_lost' });
  });
});
