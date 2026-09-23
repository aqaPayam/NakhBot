import { describe, expect, it, vi } from 'vitest';

import type { CancelPendingNakhCommand } from '@nakh/contracts';
import type { IdGenerator } from '@nakh/domain';

import { CancelPendingNakhHandler, type PendingNakhCancelStore } from './pending-cancel.js';

const command: CancelPendingNakhCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'nakh.cancel-pending',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000002' },
  requestId: '10000000-0000-4000-8000-000000000003',
  idempotencyKey: 'cancel-pending-nakh',
  occurredAt: '2026-09-23T00:00:00.000Z',
  locale: 'en',
  data: {
    pendingNakhId: '10000000-0000-4000-8000-000000000004',
    resolution: 'converted_to_like',
    expectedVersion: 1,
  },
};

describe('CancelPendingNakhHandler', () => {
  it('supplies every server-owned identity needed for either atomic resolution', async () => {
    const cancelPending = vi.fn<PendingNakhCancelStore['cancelPending']>().mockResolvedValue({
      pendingNakhId: command.data.pendingNakhId,
      status: 'cancelled',
      expiresAt: '2026-10-07T00:00:00.000Z',
      version: 2,
      replayed: false,
    });
    let sequence = 4;
    const uuid = vi.fn(() => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
    const ids: IdGenerator = {
      uuid,
    };
    const result = await new CancelPendingNakhHandler({ cancelPending }, ids).execute(command);
    expect(result.status).toBe('cancelled');
    expect(cancelPending).toHaveBeenCalledWith({
      command,
      interactionId: '10000000-0000-4000-8000-000000000005',
      matchId: '10000000-0000-4000-8000-000000000006',
      chatSessionId: '10000000-0000-4000-8000-000000000007',
      interactionEventId: '10000000-0000-4000-8000-000000000008',
      likeClosedEventId: '10000000-0000-4000-8000-000000000009',
      matchEventId: '10000000-0000-4000-8000-000000000010',
      pendingEventId: '10000000-0000-4000-8000-000000000011',
      auditId: '10000000-0000-4000-8000-000000000012',
    });
    expect(uuid).toHaveBeenCalledTimes(8);
  });

  it('rejects a non-user actor before allocating identities or writing', () => {
    const cancelPending = vi.fn<PendingNakhCancelStore['cancelPending']>();
    const uuid = vi.fn(() => command.commandId);
    const ids: IdGenerator = { uuid };
    const handler = new CancelPendingNakhHandler({ cancelPending }, ids);
    expect(() =>
      handler.execute({ ...command, actor: { ...command.actor, kind: 'system' } }),
    ).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(uuid).not.toHaveBeenCalled();
    expect(cancelPending).not.toHaveBeenCalled();
  });
});
