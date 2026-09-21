import { describe, expect, it, vi } from 'vitest';

import type { CreatePendingNakhCommand } from '@nakh/contracts';
import type { IdGenerator } from '@nakh/domain';

import { CreatePendingNakhHandler, type PendingNakhStore } from './pending.js';

const command: CreatePendingNakhCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'nakh.create-pending',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000002' },
  requestId: '10000000-0000-4000-8000-000000000003',
  idempotencyKey: 'pending-nakh-command',
  occurredAt: '2026-09-22T00:00:00.000Z',
  locale: 'en',
  data: {
    targetUserId: '10000000-0000-4000-8000-000000000004',
    text: 'Hello 🌳',
    autoSettleAuthorized: true,
  },
};

describe('CreatePendingNakhHandler', () => {
  it('validates prose and supplies only server-generated persistence identities', async () => {
    const createPending = vi.fn<PendingNakhStore['createPending']>().mockResolvedValue({
      pendingNakhId: '10000000-0000-4000-8000-000000000006',
      status: 'pending_payment',
      expiresAt: '2026-10-06T00:00:00.000Z',
      version: 1,
      replayed: false,
    });
    const values = [
      '10000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000009',
    ];
    const ids: IdGenerator = { uuid: vi.fn(() => values.shift()!) };
    const result = await new CreatePendingNakhHandler({ createPending }, ids).execute(command);
    expect(result.status).toBe('pending_payment');
    expect(createPending).toHaveBeenCalledWith({
      command,
      flowId: '10000000-0000-4000-8000-000000000005',
      pendingNakhId: '10000000-0000-4000-8000-000000000006',
      pendingPaymentId: '10000000-0000-4000-8000-000000000007',
      flowEventId: '10000000-0000-4000-8000-000000000008',
      pendingEventId: '10000000-0000-4000-8000-000000000009',
    });
  });

  it('rejects non-user actors and invalid text before persistence', async () => {
    const createPending = vi.fn<PendingNakhStore['createPending']>();
    const ids: IdGenerator = { uuid: vi.fn(() => command.commandId) };
    const handler = new CreatePendingNakhHandler({ createPending }, ids);
    await expect(
      handler.execute({ ...command, actor: { ...command.actor, kind: 'system' } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      handler.execute({ ...command, data: { ...command.data, text: ' \n ' } }),
    ).rejects.toMatchObject({ code: 'nakh_text_invalid' });
    expect(createPending).not.toHaveBeenCalled();
  });
});
