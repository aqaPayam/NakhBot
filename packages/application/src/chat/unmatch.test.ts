import { describe, expect, it, vi } from 'vitest';

import { UnmatchHandler } from './unmatch.js';

const userId = '10000000-0000-4000-8000-000000000001';
const matchId = '10000000-0000-4000-8000-000000000002';
const eventId = '10000000-0000-4000-8000-000000000003';
const token = `v1.mt.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const command = {
  commandId: '10000000-0000-4000-8000-000000000004',
  commandType: 'matching.unmatch' as const,
  schemaVersion: 1 as const,
  actor: { kind: 'user' as const, userId },
  requestId: '10000000-0000-4000-8000-000000000005',
  idempotencyKey: 'unmatch-once',
  occurredAt: '2026-09-24T00:00:00.000Z',
  locale: 'en',
  data: { matchActionToken: token, reasonCode: 'not_a_fit' },
};

describe('M6 Unmatch handler', () => {
  it('resolves an actor-bound Match and supplies the event identity', async () => {
    const unmatch = vi.fn().mockResolvedValue({});
    const resolveMatchAction = vi.fn().mockResolvedValue(matchId);
    const handler = new UnmatchHandler(
      { unmatch },
      { resolveMatchAction },
      { uuid: vi.fn().mockReturnValue(eventId) },
    );
    await handler.execute(command);
    expect(resolveMatchAction).toHaveBeenCalledWith(token, userId);
    expect(unmatch).toHaveBeenCalledWith({ command, matchId, eventId });
  });

  it('rejects stale or cross-user Match actions without calling persistence', async () => {
    const unmatch = vi.fn();
    const handler = new UnmatchHandler(
      { unmatch },
      { resolveMatchAction: vi.fn().mockResolvedValue(undefined) },
      { uuid: vi.fn() },
    );
    await expect(handler.execute(command)).rejects.toMatchObject({ code: 'chat_unavailable' });
    expect(unmatch).not.toHaveBeenCalled();
  });
});
