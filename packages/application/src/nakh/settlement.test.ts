import { describe, expect, it, vi, type Mock } from 'vitest';

import { SettlePendingNakhesHandler, type PendingNakhSettlementStepResult } from './settlement.js';

const request = {
  senderUserId: '10000000-0000-4000-8000-000000000000',
  triggerCreditTransactionId: '20000000-0000-4000-8000-000000000000',
  causationId: '30000000-0000-4000-8000-000000000000',
};

function handler(results: readonly PendingNakhSettlementStepResult[]): Readonly<{
  settleOldest: Mock;
  handler: SettlePendingNakhesHandler;
}> {
  const settleOldest = vi.fn();
  for (const result of results) settleOldest.mockResolvedValueOnce(result);
  let sequence = 0;
  return {
    settleOldest,
    handler: new SettlePendingNakhesHandler(
      { settleOldest },
      { uuid: () => `40000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` },
    ),
  };
}

describe('Pending Nakh FIFO settlement handler', () => {
  it('closes invalid oldest rows, delivers fundable rows, and stops without skipping', async () => {
    const fixture = handler([
      { outcome: 'closed_and_continue', pendingNakhId: 'oldest' },
      { outcome: 'delivered_and_continue', pendingNakhId: 'second' },
      { outcome: 'stop_insufficient_credits', pendingNakhId: 'third' },
    ]);
    await expect(fixture.handler.execute(request)).resolves.toEqual({
      deliveredCount: 1,
      closedCount: 1,
      stopped: 'insufficient_credits',
    });
    expect(fixture.settleOldest).toHaveBeenCalledTimes(3);
    expect(fixture.settleOldest.mock.calls[0]![0]).toMatchObject(request);
  });

  it('stops behind a captured external payment', async () => {
    const fixture = handler([{ outcome: 'stop_external_funding', pendingNakhId: 'oldest' }]);
    await expect(fixture.handler.execute(request)).resolves.toEqual({
      deliveredCount: 0,
      closedCount: 0,
      stopped: 'external_funding',
    });
    expect(fixture.settleOldest).toHaveBeenCalledTimes(1);
  });

  it('bounds a pass to the maximum possible sender queue', async () => {
    const fixture = handler(
      Array.from({ length: 5 }, (_, index) => ({
        outcome: 'delivered_and_continue' as const,
        pendingNakhId: String(index),
      })),
    );
    await expect(fixture.handler.execute(request)).resolves.toEqual({
      deliveredCount: 5,
      closedCount: 0,
      stopped: 'queue_bound',
    });
    expect(fixture.settleOldest).toHaveBeenCalledTimes(5);
  });
});
