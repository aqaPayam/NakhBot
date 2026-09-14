import { describe, expect, it, vi } from 'vitest';

import { DeletePhotoMediaObjects, type MediaCleanupStore } from './cleanup.js';

const photoId = '10000000-0000-4000-8000-000000000001';
const assetId = '20000000-0000-4000-8000-000000000002';
const plan = {
  assetId,
  deletionGeneration: 4,
  objectKeys: [
    `variants/test/${assetId}/thumbnail-v1.webp`,
    `validated/test/${assetId}/original`,
    `quarantine/test/${assetId}/original`,
  ],
} as const;

function fixture(overrides: Partial<MediaCleanupStore> = {}): Readonly<{
  store: MediaCleanupStore;
  complete: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}> {
  const complete = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  const store: MediaCleanupStore = {
    claimPhoto: () => Promise.resolve(plan),
    complete,
    release,
    ...overrides,
  };
  return { store, complete, release };
}

describe('DeletePhotoMediaObjects', () => {
  it('deletes only the claimed server-shaped keys before recording verified completion', async () => {
    const deleted: string[] = [];
    const { store, complete, release } = fixture();
    const handler = new DeletePhotoMediaObjects(
      store,
      {
        delete: (key) => {
          deleted.push(key);
          return Promise.resolve();
        },
      },
      'test',
      () => new Date('2026-09-10T00:00:00.000Z'),
    );
    await handler.execute(photoId, 'worker-1');
    expect(deleted).toEqual(plan.objectKeys);
    expect(complete).toHaveBeenCalledWith({
      assetId,
      deletionGeneration: 4,
      owner: 'worker-1',
      completedAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    expect(release).not.toHaveBeenCalled();
  });

  it('releases the claim and stays retryable after any object failure', async () => {
    const { store, complete, release } = fixture();
    const handler = new DeletePhotoMediaObjects(
      store,
      { delete: () => Promise.reject(new Error('r2 timeout')) },
      'test',
    );
    await expect(handler.execute(photoId, 'worker-1')).rejects.toThrow('r2 timeout');
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(assetId, 'worker-1');
  });

  it('rejects an injected or evidence key without touching storage', async () => {
    for (const key of [
      'validated/test/another-asset/original',
      `report-evidence/test/${assetId}`,
    ]) {
      const remove = vi.fn();
      const { store, release } = fixture({
        claimPhoto: () => Promise.resolve({ ...plan, objectKeys: [plan.objectKeys[2], key] }),
      });
      const handler = new DeletePhotoMediaObjects(store, { delete: remove }, 'test');
      await expect(handler.execute(photoId, 'worker-1')).rejects.toThrow(
        'invalid_media_cleanup_plan',
      );
      expect(remove).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    }
  });

  it('does nothing when another worker owns the live lease or cleanup already completed', async () => {
    const claimPhoto = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    const { store, complete } = fixture({ claimPhoto });
    await new DeletePhotoMediaObjects(store, { delete: remove }, 'test').execute(
      photoId,
      'worker-2',
    );
    expect(remove).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
