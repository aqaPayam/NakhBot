import { describe, expect, it, vi } from 'vitest';

import { MarkNotInterestedHandler, SendLikeHandler } from './interaction.js';

const clock = { now: () => new Date('2026-09-17T12:00:00.000Z') };
const ids = { uuid: vi.fn(() => '10000000-0000-4000-8000-000000000000') };

describe('M3 interaction application handlers', () => {
  it('authorizes before generating and forwarding a Like transaction', async () => {
    const sendLike = vi.fn().mockResolvedValue({
      outcome: 'liked',
      interactionId: '10000000-0000-4000-8000-000000000000',
      replayed: false,
    });
    const markNotInterested = vi.fn();
    const handler = new SendLikeHandler({ sendLike, markNotInterested }, ids, clock);
    const command = {
      commandId: '20000000-0000-4000-8000-000000000000',
      commandType: 'interaction.send-like' as const,
      schemaVersion: 1 as const,
      actor: { kind: 'user' as const, userId: '30000000-0000-4000-8000-000000000000' },
      requestId: '40000000-0000-4000-8000-000000000000',
      idempotencyKey: 'send-like:test',
      occurredAt: '2026-09-17T12:00:00.000Z',
      locale: 'en',
      data: { targetUserId: '50000000-0000-4000-8000-000000000000' },
    };
    await handler.execute(command);
    expect(sendLike).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        likeId: '10000000-0000-4000-8000-000000000000',
        matchId: '10000000-0000-4000-8000-000000000000',
        chatSessionId: '10000000-0000-4000-8000-000000000000',
        consumptionEventId: '10000000-0000-4000-8000-000000000000',
        occurredAt: clock.now(),
      }),
    );
  });

  it('rejects a non-user rejection before storage', () => {
    const sendLike = vi.fn();
    const markNotInterested = vi.fn();
    const handler = new MarkNotInterestedHandler({ sendLike, markNotInterested }, ids, clock);
    expect(() =>
      handler.execute({
        commandId: '20000000-0000-4000-8000-000000000000',
        commandType: 'interaction.mark-not-interested',
        schemaVersion: 1,
        actor: { kind: 'system', userId: '30000000-0000-4000-8000-000000000000' },
        requestId: '40000000-0000-4000-8000-000000000000',
        idempotencyKey: 'reject:test',
        occurredAt: '2026-09-17T12:00:00.000Z',
        locale: 'en',
        data: {
          targetUserId: '50000000-0000-4000-8000-000000000000',
          source: 'explore',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
    expect(markNotInterested).not.toHaveBeenCalled();
  });
});
