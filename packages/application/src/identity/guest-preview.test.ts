import { describe, expect, it, vi } from 'vitest';

import type { ConsumeGuestPreviewCommand } from '@nakh/contracts';

import { ConsumeGuestPreviewHandler, type GuestPreviewStore } from './guest-preview.js';

const command: ConsumeGuestPreviewCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'identity.consume-guest-preview',
  schemaVersion: 1,
  actor: { kind: 'user', userId: '20000000-0000-4000-8000-000000000001' },
  requestId: '30000000-0000-4000-8000-000000000001',
  idempotencyKey: 'guest-preview-receipt-1',
  occurredAt: '2026-09-05T00:00:00.000Z',
  locale: 'en',
  data: {
    candidateUserId: '40000000-0000-4000-8000-000000000001',
    deliveryReceiptId: 'telegram-delivery-1',
  },
};

describe('ConsumeGuestPreviewHandler', () => {
  it('derives the consuming User only from the authenticated actor', async () => {
    const consumeGuestPreview = vi.fn<GuestPreviewStore['consumeGuestPreview']>((write) =>
      Promise.resolve({
        userId: write.command.actor.userId,
        count: 1,
        limit: 10,
        remaining: 9,
        replayed: false,
      }),
    );
    const result = await new ConsumeGuestPreviewHandler(
      { consumeGuestPreview },
      { uuid: () => '50000000-0000-4000-8000-000000000001' },
      { now: () => new Date('2026-09-05T00:00:01.000Z') },
    ).execute(command);
    expect(result.userId).toBe(command.actor.userId);
    expect(consumeGuestPreview).toHaveBeenCalledOnce();
  });

  it('rejects a non-User actor before persistence', async () => {
    const consumeGuestPreview = vi.fn<GuestPreviewStore['consumeGuestPreview']>();
    await expect(
      new ConsumeGuestPreviewHandler(
        { consumeGuestPreview },
        { uuid: () => '50000000-0000-4000-8000-000000000001' },
        { now: () => new Date('2026-09-05T00:00:01.000Z') },
      ).execute({ ...command, actor: { kind: 'system', userId: command.actor.userId } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(consumeGuestPreview).not.toHaveBeenCalled();
  });
});
