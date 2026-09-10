import { describe, expect, it, vi } from 'vitest';

import { RevokePhotoDeliveryCache } from './cache-revocation.js';

const photoId = '10000000-0000-4000-8000-000000000001';
const assetId = '20000000-0000-4000-8000-000000000002';

describe('RevokePhotoDeliveryCache', () => {
  it('deduplicates and sorts versioned logical paths before purge', async () => {
    const purgePaths = vi.fn().mockResolvedValue(undefined);
    const thumbnail = `/media/${assetId}/thumbnail-v1.webp`;
    const blur = `/media/${assetId}/blurred-preview-v1.webp`;
    const handler = new RevokePhotoDeliveryCache(
      { listDeliveryPaths: () => Promise.resolve([thumbnail, blur, thumbnail]) },
      { purgePaths },
    );
    await handler.execute(photoId);
    expect(purgePaths).toHaveBeenCalledWith([blur, thumbnail]);
  });

  it('does nothing when the photo has no materialized renditions', async () => {
    const purgePaths = vi.fn();
    const handler = new RevokePhotoDeliveryCache(
      { listDeliveryPaths: () => Promise.resolve([]) },
      { purgePaths },
    );
    await handler.execute(photoId);
    expect(purgePaths).not.toHaveBeenCalled();
  });

  it('rejects forged identifiers and arbitrary paths before provider access', async () => {
    const purgePaths = vi.fn();
    const handler = new RevokePhotoDeliveryCache(
      { listDeliveryPaths: () => Promise.resolve(['https://attacker.example/object']) },
      { purgePaths },
    );
    await expect(handler.execute('not-a-photo')).rejects.toThrow(
      'invalid_media_cache_revoke_request',
    );
    await expect(handler.execute(photoId)).rejects.toThrow('invalid_media_delivery_path');
    expect(purgePaths).not.toHaveBeenCalled();
  });

  it('propagates provider failure so the durable event is retried', async () => {
    const handler = new RevokePhotoDeliveryCache(
      {
        listDeliveryPaths: () => Promise.resolve([`/media/${assetId}/thumbnail-v1.webp`]),
      },
      { purgePaths: () => Promise.reject(new Error('cache_purge_unavailable')) },
    );
    await expect(handler.execute(photoId)).rejects.toThrow('cache_purge_unavailable');
  });
});
