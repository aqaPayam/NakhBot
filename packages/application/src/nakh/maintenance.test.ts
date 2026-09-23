import { describe, expect, it, vi } from 'vitest';

import { RunNakhMaintenanceBatchHandler, type NakhMaintenanceStore } from './maintenance.js';

function store(overrides: Partial<NakhMaintenanceStore> = {}): NakhMaintenanceStore {
  return {
    expirePending: vi.fn().mockResolvedValue({ examined: 0, changed: 0 }),
    expireDelivered: vi.fn().mockResolvedValue({ examined: 0, changed: 0 }),
    sendPendingReminders: vi.fn().mockResolvedValue({ examined: 0, changed: 0 }),
    ...overrides,
  };
}

describe('Nakh maintenance batch', () => {
  it('expires both clocks before dispatching optional reminders', async () => {
    const order: string[] = [];
    const persistence = store({
      expirePending: vi.fn(() => {
        order.push('pending-expiry');
        return Promise.resolve({ examined: 2, changed: 2 });
      }),
      expireDelivered: vi.fn(() => {
        order.push('delivered-expiry');
        return Promise.resolve({ examined: 1, changed: 1 });
      }),
      sendPendingReminders: vi.fn(() => {
        order.push('reminders');
        return Promise.resolve({ examined: 3, changed: 3 });
      }),
    });

    await expect(new RunNakhMaintenanceBatchHandler(persistence).execute(100)).resolves.toEqual({
      pendingExpired: { examined: 2, changed: 2 },
      deliveredExpired: { examined: 1, changed: 1 },
      remindersSent: { examined: 3, changed: 3 },
      hasMore: false,
    });
    expect(order).toEqual(['pending-expiry', 'delivered-expiry', 'reminders']);
  });

  it('requests an immediate catch-up pass when any phase fills its bound', async () => {
    const persistence = store({
      expireDelivered: vi.fn().mockResolvedValue({ examined: 10, changed: 9 }),
    });
    await expect(
      new RunNakhMaintenanceBatchHandler(persistence).execute(10),
    ).resolves.toMatchObject({
      hasMore: true,
    });
  });

  it.each([0, 251, 1.5, Number.NaN])('rejects unsafe batch limit %s', async (limit) => {
    await expect(new RunNakhMaintenanceBatchHandler(store()).execute(limit)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
