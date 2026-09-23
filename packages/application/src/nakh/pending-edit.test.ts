import { describe, expect, it, vi } from 'vitest';

import type { EditPendingNakhCommand } from '@nakh/contracts';
import type { IdGenerator } from '@nakh/domain';

import { EditPendingNakhHandler, type PendingNakhEditStore } from './pending-edit.js';

const command: EditPendingNakhCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'nakh.edit-pending',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000002' },
  requestId: '10000000-0000-4000-8000-000000000003',
  idempotencyKey: 'edit-pending-nakh',
  occurredAt: '2026-09-22T00:00:00.000Z',
  locale: 'en',
  data: {
    pendingNakhId: '10000000-0000-4000-8000-000000000004',
    text: 'A better private hello 🌳',
    expectedVersion: 1,
  },
};

describe('EditPendingNakhHandler', () => {
  it('validates prose and supplies a server-owned outbox identity', async () => {
    const editPending = vi.fn<PendingNakhEditStore['editPending']>().mockResolvedValue({
      pendingNakhId: command.data.pendingNakhId,
      status: 'pending_payment',
      expiresAt: '2026-10-06T00:00:00.000Z',
      version: 2,
      replayed: false,
    });
    const ids: IdGenerator = {
      uuid: vi.fn(() => '10000000-0000-4000-8000-000000000005'),
    };
    const result = await new EditPendingNakhHandler({ editPending }, ids).execute(command);
    expect(result.version).toBe(2);
    expect(editPending).toHaveBeenCalledWith({
      command,
      pendingEventId: '10000000-0000-4000-8000-000000000005',
    });
  });

  it('rejects non-user actors and invalid prose before persistence', () => {
    const editPending = vi.fn<PendingNakhEditStore['editPending']>();
    const ids: IdGenerator = { uuid: vi.fn(() => command.commandId) };
    const handler = new EditPendingNakhHandler({ editPending }, ids);
    expect(() =>
      handler.execute({ ...command, actor: { ...command.actor, kind: 'system' } }),
    ).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => handler.execute({ ...command, data: { ...command.data, text: ' \n ' } })).toThrow(
      expect.objectContaining({ code: 'nakh_text_invalid' }),
    );
    expect(editPending).not.toHaveBeenCalled();
  });
});
