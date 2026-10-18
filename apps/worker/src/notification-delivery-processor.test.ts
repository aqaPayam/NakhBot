import { describe, expect, it, vi, type Mock } from 'vitest';

import type { NotificationDeliveryCoordinator } from '@nakh/application';
import { TelegramNotificationSendFailure, type TelegramNotificationSender } from '@nakh/telegram';

import {
  NotificationDeliveryProcessor,
  type NotificationRendererPort,
} from './notification-delivery-processor.js';

const claim = {
  deliveryId: '10000000-0000-4000-8000-000000000001',
  notificationId: '10000000-0000-4000-8000-000000000002',
  fenceToken: '3',
  leaseExpiresAt: '2026-09-24T00:01:00.000Z',
  attemptNumber: 2,
};
const projection = {
  deliveryId: claim.deliveryId,
  telegramUserId: '123456789',
  locale: 'en',
  titleKey: 'notification.test.title',
  bodyKey: 'notification.test.body',
};

type Fixture = Readonly<{
  coordinator: Readonly<{
    claim: Mock<NotificationDeliveryCoordinator['claim']>;
    loadTelegramProjection: Mock<NotificationDeliveryCoordinator['loadTelegramProjection']>;
    markProviderCallStarted: Mock<NotificationDeliveryCoordinator['markProviderCallStarted']>;
    settle: Mock<NotificationDeliveryCoordinator['settle']>;
  }>;
  renderer: Readonly<{ render: Mock<NotificationRendererPort['render']> }>;
  sender: Readonly<{ send: Mock<TelegramNotificationSender['send']> }>;
  processor: NotificationDeliveryProcessor;
}>;

function fixture(): Fixture {
  const coordinator = {
    claim: vi.fn<NotificationDeliveryCoordinator['claim']>().mockResolvedValue([claim]),
    loadTelegramProjection: vi
      .fn<NotificationDeliveryCoordinator['loadTelegramProjection']>()
      .mockResolvedValue(projection),
    markProviderCallStarted: vi
      .fn<NotificationDeliveryCoordinator['markProviderCallStarted']>()
      .mockResolvedValue(true),
    settle: vi.fn<NotificationDeliveryCoordinator['settle']>().mockResolvedValue(true),
  };
  const renderer = {
    render: vi
      .fn<NotificationRendererPort['render']>()
      .mockResolvedValue({ title: 'Hello', body: 'World' }),
  };
  const sender = {
    send: vi
      .fn<TelegramNotificationSender['send']>()
      .mockResolvedValue({ providerMessageKey: 'telegram:42' }),
  };
  const processor = new NotificationDeliveryProcessor(
    coordinator,
    renderer,
    sender,
    'notification:worker-one',
    () => '10000000-0000-4000-8000-000000000010',
    () => new Date('2026-09-24T00:00:00.000Z'),
  );
  return { coordinator, renderer, sender, processor };
}

describe('M6 notification delivery worker', () => {
  it('binds replies only after durable success and never resends after a binding cache failure', async () => {
    const f = fixture();
    const delivered = vi.fn().mockRejectedValue(new Error('Redis unavailable'));
    Object.assign(f.renderer, { delivered });
    f.renderer.render.mockResolvedValue({
      title: 'Chat',
      body: 'private',
      format: 'plain',
      replyMarkup: { inline_keyboard: [[{ text: 'Open chat', callback_data: 'm9c:opaque' }]] },
      replyBinding: {
        recipient: projection.telegramUserId,
        state: {
          version: 0,
          screen: 'chat_text',
          action: 'reply',
          actor: {
            kind: 'user',
            userId: claim.notificationId,
            productEpoch: 0,
            sessionGrantId: claim.deliveryId,
          },
        },
      },
    });
    await expect(f.processor.processNext()).resolves.toEqual({ outcome: 'delivered' });
    expect(f.coordinator.settle).toHaveBeenCalledTimes(1);
    expect(f.coordinator.settle.mock.invocationCallOrder[0]).toBeLessThan(
      delivered.mock.invocationCallOrder[0]!,
    );
    expect(f.sender.send).toHaveBeenCalledTimes(1);
    expect(f.sender.send.mock.calls[0]![0]).not.toHaveProperty('replyBinding');
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'private' }),
      'telegram:42',
    );
  });

  it('does not bind a reply after lost settlement or an ambiguous provider result', async () => {
    for (const ambiguous of [false, true]) {
      const f = fixture(),
        delivered = vi.fn();
      Object.assign(f.renderer, { delivered });
      if (ambiguous) f.sender.send.mockRejectedValue(new Error('connection lost'));
      else f.coordinator.settle.mockResolvedValue(false);
      await expect(f.processor.processNext()).resolves.toEqual(
        ambiguous
          ? { outcome: 'quarantined', reasonCode: 'ambiguous_result' }
          : { outcome: 'lease_lost' },
      );
      expect(delivered).not.toHaveBeenCalled();
    }
  });
  it('marks provider progress before sending and settles known success', async () => {
    const { coordinator, sender, processor } = fixture();
    await expect(processor.processNext()).resolves.toEqual({ outcome: 'delivered' });
    expect(coordinator.markProviderCallStarted.mock.invocationCallOrder[0]).toBeLessThan(
      sender.send.mock.invocationCallOrder[0]!,
    );
    const [settlement, attemptNumber] = coordinator.settle.mock.calls[0]!;
    expect(settlement.data).toEqual({
      deliveryId: claim.deliveryId,
      leaseOwner: 'notification:worker-one',
      fenceToken: '3',
      result: { outcome: 'sent', providerMessageKey: 'telegram:42' },
    });
    expect(attemptNumber).toBe(2);
  });

  it('does not contact Telegram when the projection or lease is unavailable', async () => {
    const missing = fixture();
    missing.coordinator.loadTelegramProjection.mockResolvedValue(undefined);
    await expect(missing.processor.processNext()).resolves.toEqual({
      outcome: 'failed',
      reasonCode: 'recipient_unavailable',
    });
    expect(missing.coordinator.markProviderCallStarted).not.toHaveBeenCalled();
    expect(missing.sender.send).not.toHaveBeenCalled();

    const stale = fixture();
    stale.coordinator.markProviderCallStarted.mockResolvedValue(false);
    await expect(stale.processor.processNext()).resolves.toEqual({ outcome: 'lease_lost' });
    expect(stale.sender.send).not.toHaveBeenCalled();
  });

  it('honors provider retry-after and quarantines uncertain calls', async () => {
    const limited = fixture();
    limited.sender.send.mockRejectedValue(
      new TelegramNotificationSendFailure('rate_limited', 8_000),
    );
    await expect(limited.processor.processNext()).resolves.toEqual({
      outcome: 'retry_scheduled',
      reasonCode: 'rate_limited',
    });
    const [settlement, attemptNumber] = limited.coordinator.settle.mock.calls[0]!;
    expect(settlement.data.result).toEqual({
      outcome: 'failed_retryable',
      failureCode: 'rate_limited',
      retryAfterMs: 8_000,
    });
    expect(attemptNumber).toBe(2);

    const uncertain = fixture();
    uncertain.sender.send.mockRejectedValue(new Error('unsafe transport detail'));
    await expect(uncertain.processor.processNext()).resolves.toEqual({
      outcome: 'quarantined',
      reasonCode: 'ambiguous_result',
    });
  });

  it('retries rendering failures without beginning a provider call', async () => {
    const { coordinator, renderer, sender, processor } = fixture();
    renderer.render.mockRejectedValue(new Error('catalog unavailable'));
    await expect(processor.processNext()).resolves.toEqual({
      outcome: 'retry_scheduled',
      reasonCode: 'provider_unavailable',
    });
    expect(coordinator.markProviderCallStarted).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
