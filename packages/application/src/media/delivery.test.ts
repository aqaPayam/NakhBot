import { describe, expect, it, vi } from 'vitest';

import type { ResolveMediaDeliveryGrantQuery } from '@nakh/contracts';

import { ResolveMediaDeliveryGrantHandler } from './delivery.js';

const query: ResolveMediaDeliveryGrantQuery = {
  actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000001' },
  requestId: '20000000-0000-4000-8000-000000000002',
  photoId: '30000000-0000-4000-8000-000000000003',
  purpose: 'profile_card',
  requestedVariant: 'thumbnail',
};

describe('ResolveMediaDeliveryGrantHandler', () => {
  it('returns only a short-lived signed URL and public delivery facts', async () => {
    const authorize = vi.fn().mockResolvedValue({
      deliveryPath: '/media/40000000-0000-4000-8000-000000000004/thumbnail-v1.webp',
      variantType: 'thumbnail',
      cachePolicy: 'private',
    });
    const sign = vi.fn().mockReturnValue('https://media.example/signed');
    const handler = new ResolveMediaDeliveryGrantHandler(
      { authorize },
      { sign },
      { now: () => new Date('2027-01-15T08:00:00.000Z') },
    );
    await expect(handler.execute(query)).resolves.toEqual({
      deliveryUrl: 'https://media.example/signed',
      expiresAt: '2027-01-15T08:01:00.000Z',
      variantType: 'thumbnail',
      cachePolicy: 'private',
    });
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceId: query.actor.userId,
        purpose: 'profile_card',
        variant: 'thumbnail',
      }),
    );
  });

  it('keeps ordinary users out of moderation delivery before persistence', async () => {
    const authorize = vi.fn();
    const handler = new ResolveMediaDeliveryGrantHandler(
      { authorize },
      { sign: vi.fn() },
      { now: () => new Date() },
    );
    await expect(
      handler.execute({ ...query, purpose: 'moderation_evidence' }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('fails closed if authorization returns a different rendition', async () => {
    const handler = new ResolveMediaDeliveryGrantHandler(
      {
        authorize: () =>
          Promise.resolve({
            deliveryPath: '/media/x/blurred-preview-v1.webp',
            variantType: 'blurred_preview',
            cachePolicy: 'no-store',
          }),
      },
      { sign: vi.fn() },
      { now: () => new Date() },
    );
    await expect(handler.execute(query)).rejects.toMatchObject({ code: 'media_delivery_denied' });
  });
});
