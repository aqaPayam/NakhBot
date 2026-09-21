import { describe, expect, it, vi } from 'vitest';

import type { SpendCreditsForActionCommand } from '@nakh/contracts';

import { SpendCreditsForPaidActionHandler } from './paid-action.js';

const command: SpendCreditsForActionCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'billing.spend-credits-for-action',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000002' },
  requestId: '10000000-0000-4000-8000-000000000003',
  idempotencyKey: 'credit-unlock-command',
  occurredAt: '2026-09-21T00:00:00.000Z',
  locale: 'en',
  data: {
    target: {
      type: 'liked_by_profile_unlock',
      actionToken: `v1.lb.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    },
  },
};

describe('M4 paid action coordinator', () => {
  it('resolves an opaque action token and delegates one generated atomic write', async () => {
    const spendCredits = vi.fn().mockResolvedValue({
      id: '10000000-0000-4000-8000-000000000004',
      featureType: 'liked_by_profile_unlock',
      unlockedAt: new Date(command.occurredAt),
      replayed: false,
    });
    const handler = new SpendCreditsForPaidActionHandler(
      { spendCredits },
      {
        resolveLikedByAction: vi.fn().mockResolvedValue('10000000-0000-4000-8000-000000000005'),
        resolveChatUnlockAction: vi.fn(),
      },
      {
        uuid: vi
          .fn()
          .mockReturnValueOnce('10000000-0000-4000-8000-000000000004')
          .mockReturnValueOnce('10000000-0000-4000-8000-000000000006')
          .mockReturnValueOnce('10000000-0000-4000-8000-000000000007'),
      },
    );
    await expect(handler.execute(command)).resolves.toMatchObject({
      featureUnlockId: '10000000-0000-4000-8000-000000000004',
      featureType: 'liked_by_profile_unlock',
      status: 'active',
      replayed: false,
    });
    expect(spendCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: command.actor.userId,
        target: { type: 'like', targetId: '10000000-0000-4000-8000-000000000005' },
        correlationId: command.requestId,
      }),
    );
  });
});
