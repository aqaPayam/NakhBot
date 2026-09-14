import { describe, expect, it, vi } from 'vitest';

import { ReconcileMediaObjectCandidates } from './orphan-reconciliation.js';

const asset = '20000000-0000-4000-8000-000000000002';
const old = new Date('2026-09-10T00:00:00.000Z');
const recent = new Date('2026-09-12T12:00:00.000Z');

describe('ReconcileMediaObjectCandidates', () => {
  it('deletes only old unreferenced objects after a fresh reference check', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const referencedKey = `validated/test/${asset}/original`;
    const reconcile = new ReconcileMediaObjectCandidates(
      { findReferenced: () => Promise.resolve(new Set([referencedKey])) },
      { delete: remove },
      'test',
      24 * 60 * 60 * 1_000,
      () => new Date('2026-09-12T00:00:00.000Z'),
    );
    await expect(
      reconcile.execute([
        { key: referencedKey, lastModified: old },
        { key: `variants/test/${asset}/thumbnail-v1.webp`, lastModified: old },
        { key: `quarantine/test/${asset}/original`, lastModified: recent },
      ]),
    ).resolves.toEqual({ examined: 3, deferred: 1, referenced: 1, deleted: 1 });
    expect(remove).toHaveBeenCalledWith(
      `variants/test/${asset}/thumbnail-v1.webp`,
      expect.any(AbortSignal),
    );
  });

  it('rejects foreign namespaces, malformed keys, duplicates, and oversized batches', async () => {
    const references = { findReferenced: vi.fn() };
    const remove = vi.fn();
    const reconcile = new ReconcileMediaObjectCandidates(references, { delete: remove }, 'test');
    for (const key of [
      `report-evidence/test/${asset}/original`,
      `validated/production/${asset}/original`,
      `variants/test/${asset}/thumbnail-v0.webp`,
    ])
      await expect(reconcile.execute([{ key, lastModified: old }])).rejects.toThrow(
        'invalid_media_orphan_candidate',
      );
    await expect(
      reconcile.execute([
        { key: `quarantine/test/${asset}/original`, lastModified: old },
        { key: `quarantine/test/${asset}/original`, lastModified: old },
      ]),
    ).rejects.toThrow('invalid_media_orphan_candidate');
    await expect(
      reconcile.execute(
        Array.from({ length: 101 }, (_, index) => ({
          key: `quarantine/test/${asset}/original-${index}`,
          lastModified: old,
        })),
      ),
    ).rejects.toThrow('media_orphan_batch_too_large');
    expect(references.findReferenced).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('stops on an unknown deletion result so the page can retry', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('provider timeout'));
    const reconcile = new ReconcileMediaObjectCandidates(
      { findReferenced: () => Promise.resolve(new Set()) },
      { delete: remove },
      'test',
    );
    await expect(
      reconcile.execute([{ key: `quarantine/test/${asset}/original`, lastModified: old }]),
    ).rejects.toThrow('provider timeout');
  });
});
