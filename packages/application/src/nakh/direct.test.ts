import { describe, expect, it, vi } from 'vitest';

import type { CreateDirectNakhCommand } from '@nakh/contracts';
import type { IdGenerator } from '@nakh/domain';

import { CreateDirectNakhHandler, type DirectNakhStore } from './direct.js';

const command: CreateDirectNakhCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'nakh.create-direct',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000002' },
  requestId: '10000000-0000-4000-8000-000000000003',
  idempotencyKey: 'direct-nakh-command',
  occurredAt: '2026-09-22T00:00:00.000Z',
  locale: 'en',
  data: { targetUserId: '10000000-0000-4000-8000-000000000004', text: 'Hello 🌳' },
};

describe('CreateDirectNakhHandler', () => {
  it('validates prose and supplies every server-owned transaction identity', async () => {
    const createDirect = vi.fn<DirectNakhStore['createDirect']>().mockResolvedValue({
      nakhId: '10000000-0000-4000-8000-000000000006',
      status: 'sent',
      sentAt: '2026-09-22T00:00:00.000Z',
      expiresAt: '2026-10-06T00:00:00.000Z',
      replayed: false,
    });
    const values = Array.from(
      { length: 6 },
      (_, index) => `10000000-0000-4000-8000-${(index + 5).toString().padStart(12, '0')}`,
    );
    const ids: IdGenerator = { uuid: vi.fn(() => values.shift()!) };
    const result = await new CreateDirectNakhHandler({ createDirect }, ids).execute(command);
    expect(result.status).toBe('sent');
    expect(createDirect).toHaveBeenCalledWith({
      command,
      flowId: '10000000-0000-4000-8000-000000000005',
      nakhId: '10000000-0000-4000-8000-000000000006',
      creditTransactionId: '10000000-0000-4000-8000-000000000007',
      historyId: '10000000-0000-4000-8000-000000000008',
      flowEventId: '10000000-0000-4000-8000-000000000009',
      deliveredEventId: '10000000-0000-4000-8000-000000000010',
    });
  });

  it('rejects non-user actors and invalid text before persistence', () => {
    const createDirect = vi.fn<DirectNakhStore['createDirect']>();
    const ids: IdGenerator = { uuid: vi.fn(() => command.commandId) };
    const handler = new CreateDirectNakhHandler({ createDirect }, ids);
    expect(() =>
      handler.execute({ ...command, actor: { ...command.actor, kind: 'system' } }),
    ).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => handler.execute({ ...command, data: { ...command.data, text: ' \n ' } })).toThrow(
      expect.objectContaining({ code: 'nakh_text_invalid' }),
    );
    expect(createDirect).not.toHaveBeenCalled();
  });
});
