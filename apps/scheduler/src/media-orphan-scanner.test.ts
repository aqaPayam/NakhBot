import { describe, expect, it, vi } from 'vitest';

import { MediaOrphanScanner, type MediaObjectListingPort } from './media-orphan-scanner.js';

describe('MediaOrphanScanner', () => {
  it('advances one durable bounded page for each ordinary private namespace', async () => {
    const listObjects = vi
      .fn<MediaObjectListingPort['listObjects']>()
      .mockResolvedValue({ objects: [], nextCursor: 'next' });
    const get = vi.fn().mockResolvedValueOnce('prior').mockResolvedValue(undefined);
    const advance = vi.fn().mockResolvedValue(undefined);
    const execute = vi
      .fn()
      .mockResolvedValue({ examined: 0, deferred: 0, referenced: 0, deleted: 0 });
    const scanner = new MediaOrphanScanner(
      { listObjects },
      { get, advance },
      { execute },
      'staging',
    );
    await expect(scanner.scanOnePagePerPrefix()).resolves.toEqual({
      examined: 0,
      deferred: 0,
      referenced: 0,
      deleted: 0,
    });
    expect(listObjects).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prefix: 'quarantine/staging/', cursor: 'prior', limit: 20 }),
    );
    expect(listObjects.mock.calls[1]?.[0]).not.toHaveProperty('cursor');
    expect(advance).toHaveBeenCalledTimes(3);
  });

  it('does not advance a cursor after reconciliation fails', async () => {
    const advance = vi.fn();
    const scanner = new MediaOrphanScanner(
      { listObjects: () => Promise.resolve({ objects: [] }) },
      { get: () => Promise.resolve(undefined), advance },
      { execute: () => Promise.reject(new Error('delete unknown')) },
      'test',
    );
    await expect(scanner.scanOnePagePerPrefix()).rejects.toThrow('delete unknown');
    expect(advance).not.toHaveBeenCalled();
  });
});
