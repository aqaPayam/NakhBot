import { describe, expect, it, vi, type Mock } from 'vitest';

import { NotificationDeliveryCoordinator, type NotificationDeliveryStore } from './delivery.js';

const deliveryId = '10000000-0000-4000-8000-000000000001';
const notificationId = '10000000-0000-4000-8000-000000000002';
const commandId = '10000000-0000-4000-8000-000000000003';
const requestId = '10000000-0000-4000-8000-000000000004';
const actor = { kind: 'system' as const, userId: '10000000-0000-4000-8000-000000000005' };
const envelope = {
  commandId,
  schemaVersion: 1 as const,
  actor,
  requestId,
  idempotencyKey: 'notification-delivery-once',
  occurredAt: '2026-09-24T00:00:00.000Z',
  locale: 'en',
};

type StoreMock = Readonly<{
  claimDue: Mock<NotificationDeliveryStore['claimDue']>;
  loadTelegramProjection: Mock<NotificationDeliveryStore['loadTelegramProjection']>;
  markProviderCallStarted: Mock<NotificationDeliveryStore['markProviderCallStarted']>;
  settle: Mock<NotificationDeliveryStore['settle']>;
}>;

function fixture(): Readonly<{
  store: StoreMock;
  coordinator: NotificationDeliveryCoordinator;
}> {
  const store = {
    claimDue: vi.fn<NotificationDeliveryStore['claimDue']>().mockResolvedValue([
      {
        deliveryId,
        notificationId,
        fenceToken: '4',
        leaseExpiresAt: '2026-09-24T00:01:00.000Z',
        attemptNumber: 2,
      },
    ]),
    loadTelegramProjection: vi
      .fn<NotificationDeliveryStore['loadTelegramProjection']>()
      .mockResolvedValue({
        deliveryId,
        telegramUserId: '123456789',
        locale: 'en',
        titleKey: 'notification.safety.title',
        bodyKey: 'notification.safety.body',
      }),
    markProviderCallStarted: vi
      .fn<NotificationDeliveryStore['markProviderCallStarted']>()
      .mockResolvedValue(true),
    settle: vi.fn<NotificationDeliveryStore['settle']>().mockResolvedValue(true),
  };
  const coordinator = new NotificationDeliveryCoordinator(
    store,
    { now: () => new Date('2026-09-24T00:00:00.000Z') },
    () => 0.5,
  );
  return { store, coordinator };
}

describe('M6 notification delivery coordinator', () => {
  it('allows only a system worker to claim bounded delivery leases', async () => {
    const { store, coordinator } = fixture();
    await expect(
      coordinator.claim({
        ...envelope,
        commandType: 'notification.claim-deliveries',
        data: { workerId: 'worker:one', limit: 10 },
      }),
    ).resolves.toHaveLength(1);
    expect(store.claimDue).toHaveBeenCalledWith({
      workerId: 'worker:one',
      limit: 10,
      leaseMs: 60_000,
    });
    await expect(
      coordinator.claim({
        ...envelope,
        actor: { kind: 'user', userId: actor.userId },
        commandType: 'notification.claim-deliveries',
        data: { workerId: 'worker:one', limit: 1 },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('marks the exact lease before a provider call', async () => {
    const { store, coordinator } = fixture();
    const lease = { deliveryId, leaseOwner: 'worker:one', fenceToken: '4' };
    await expect(coordinator.markProviderCallStarted(lease)).resolves.toBe(true);
    expect(store.markProviderCallStarted).toHaveBeenCalledWith(lease);
  });

  it('honors bounded provider retry-after through the shared failure policy', async () => {
    const { store, coordinator } = fixture();
    await coordinator.settle(
      {
        ...envelope,
        commandType: 'notification.settle-delivery',
        data: {
          deliveryId,
          leaseOwner: 'worker:one',
          fenceToken: '4',
          result: { outcome: 'failed_retryable', failureCode: 'rate_limited', retryAfterMs: 9_000 },
        },
      },
      2,
    );
    expect(store.settle).toHaveBeenCalledWith({
      deliveryId,
      leaseOwner: 'worker:one',
      fenceToken: '4',
      attemptNumber: 2,
      outcome: 'failed_retryable',
      failureCode: 'rate_limited',
      retryDelayMs: 9_000,
    });
  });

  it('quarantines an ambiguous result and rejects arbitrary failure codes', async () => {
    const { store, coordinator } = fixture();
    await coordinator.settle(
      {
        ...envelope,
        commandType: 'notification.settle-delivery',
        data: {
          deliveryId,
          leaseOwner: 'worker:one',
          fenceToken: '4',
          result: { outcome: 'ambiguous', failureCode: 'ambiguous_result' },
        },
      },
      2,
    );
    expect(store.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed_terminal',
        failureCode: 'ambiguous_result',
        quarantine: true,
      }),
    );
    await expect(
      coordinator.settle(
        {
          ...envelope,
          commandType: 'notification.settle-delivery',
          data: {
            deliveryId,
            leaseOwner: 'worker:one',
            fenceToken: '4',
            result: { outcome: 'failed_terminal', failureCode: 'raw_provider_error' },
          },
        },
        2,
      ),
    ).rejects.toMatchObject({ code: 'notification_delivery_invalid' });
  });
});
