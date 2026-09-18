import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi, type Mock } from 'vitest';

import { GetLockedLikedByPageHandler } from './liked-by-page.js';

const receiverId = randomUUID();
const query = {
  actor: { kind: 'user' as const, userId: receiverId },
  requestId: randomUUID(),
  limit: 2,
};
const grant = {
  deliveryUrl: 'https://media.example.test/blur',
  expiresAt: '2026-01-01T00:01:00.000Z',
  variantType: 'blurred_preview' as const,
  cachePolicy: 'no-store' as const,
};
const rows = [
  {
    likeId: randomUUID(),
    primaryPhotoId: randomUUID(),
    assetId: randomUUID(),
    createdAt: new Date(),
  },
  {
    likeId: randomUUID(),
    primaryPhotoId: randomUUID(),
    assetId: randomUUID(),
    createdAt: new Date(),
  },
];

type Fixture = Readonly<{
  store: { readActionablePage: Mock };
  references: { resolveCursor: Mock; issueCursor: Mock; issueAction: Mock };
  blur: { execute: Mock };
  grants: { execute: Mock };
}>;

function fixture(): Fixture {
  const store = {
    readActionablePage: vi.fn().mockResolvedValue({ totalCount: 3, rows, hasMore: true }),
  };
  const references = {
    resolveCursor: vi.fn().mockResolvedValue(undefined),
    issueCursor: vi.fn().mockResolvedValue('v1.lb.abcdefghijklmnop.abcdefghijklmnop'),
    issueAction: vi.fn().mockResolvedValue('v1.lb.ponmlkjihgfedcba.ponmlkjihgfedcba'),
  };
  const blur = { execute: vi.fn().mockResolvedValue('/internal/blurred-path') };
  const grants = { execute: vi.fn().mockResolvedValue(grant) };
  return { store, references, blur, grants };
}

describe('GetLockedLikedByPageHandler', () => {
  it('returns only locked cards, grants, and opaque references in stable order', async () => {
    const parts = fixture();
    const handler = new GetLockedLikedByPageHandler(
      parts.store,
      parts.references,
      parts.blur,
      parts.grants,
    );
    const result = await handler.execute(query);
    expect(result).toEqual({
      totalCount: 3,
      cards: rows.map(() => ({
        actionToken: 'v1.lb.ponmlkjihgfedcba.ponmlkjihgfedcba',
        blurredPhoto: grant,
      })),
      nextCursor: 'v1.lb.abcdefghijklmnop.abcdefghijklmnop',
    });
    expect(parts.store.readActionablePage).toHaveBeenCalledWith(query, undefined);
    expect(parts.blur.execute).toHaveBeenNthCalledWith(1, rows[0]!.assetId);
    expect(parts.blur.execute).toHaveBeenNthCalledWith(2, rows[1]!.assetId);
    expect(parts.grants.execute).toHaveBeenCalledWith({
      actor: query.actor,
      requestId: query.requestId,
      photoId: rows[0]!.primaryPhotoId,
      purpose: 'liked_by_blur',
      requestedVariant: 'blurred_preview',
    });
    expect(parts.references.issueCursor).toHaveBeenCalledWith(receiverId, {
      createdAt: rows[1]!.createdAt,
      likeId: rows[1]!.likeId,
    });
    for (const row of rows) {
      expect(JSON.stringify(result)).not.toContain(row.likeId);
      expect(JSON.stringify(result)).not.toContain(row.primaryPhotoId);
      expect(JSON.stringify(result)).not.toContain(row.assetId);
    }
  });

  it('fails before a database read for another actor or an invalid cursor', async () => {
    const parts = fixture();
    const handler = new GetLockedLikedByPageHandler(
      parts.store,
      parts.references,
      parts.blur,
      parts.grants,
    );
    await expect(
      handler.execute({ ...query, actor: { ...query.actor, kind: 'admin' } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      handler.execute({ ...query, cursor: 'stale-reference-value' }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(parts.store.readActionablePage).not.toHaveBeenCalled();
  });

  it('passes a verified receiver-bound cursor to the actionable query', async () => {
    const parts = fixture();
    const after = { createdAt: rows[0]!.createdAt, likeId: rows[0]!.likeId };
    parts.references.resolveCursor.mockResolvedValue(after);
    parts.store.readActionablePage.mockResolvedValue({ totalCount: 0, rows: [], hasMore: false });
    const handler = new GetLockedLikedByPageHandler(
      parts.store,
      parts.references,
      parts.blur,
      parts.grants,
    );
    const withCursor = { ...query, cursor: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba' };
    await expect(handler.execute(withCursor)).resolves.toEqual({ totalCount: 0, cards: [] });
    expect(parts.references.resolveCursor).toHaveBeenCalledWith(withCursor.cursor, receiverId);
    expect(parts.store.readActionablePage).toHaveBeenCalledWith(withCursor, after);
  });

  it('does not issue an action token when the final media authorization fails', async () => {
    const parts = fixture();
    parts.store.readActionablePage.mockResolvedValue({
      totalCount: 1,
      rows: rows.slice(0, 1),
      hasMore: false,
    });
    parts.grants.execute.mockRejectedValue(new Error('denied'));
    const handler = new GetLockedLikedByPageHandler(
      parts.store,
      parts.references,
      parts.blur,
      parts.grants,
    );
    await expect(handler.execute(query)).rejects.toThrow('denied');
    expect(parts.references.issueAction).not.toHaveBeenCalled();
  });

  it('rejects an incorrectly classified grant before issuing an action token', async () => {
    const parts = fixture();
    parts.store.readActionablePage.mockResolvedValue({
      totalCount: 1,
      rows: rows.slice(0, 1),
      hasMore: false,
    });
    parts.grants.execute.mockResolvedValue({ ...grant, variantType: 'thumbnail' });
    const handler = new GetLockedLikedByPageHandler(
      parts.store,
      parts.references,
      parts.blur,
      parts.grants,
    );
    await expect(handler.execute(query)).rejects.toMatchObject({ code: 'internal_error' });
    expect(parts.references.issueAction).not.toHaveBeenCalled();
  });

  it('bounds simultaneous on-demand media work for a larger page', async () => {
    const parts = fixture();
    const manyRows = Array.from({ length: 9 }, () => ({
      likeId: randomUUID(),
      primaryPhotoId: randomUUID(),
      assetId: randomUUID(),
      createdAt: new Date(),
    }));
    parts.store.readActionablePage.mockResolvedValue({
      totalCount: manyRows.length,
      rows: manyRows,
      hasMore: false,
    });
    let active = 0;
    let peak = 0;
    parts.blur.execute.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return '/internal/blurred-path';
    });
    const handler = new GetLockedLikedByPageHandler(
      parts.store,
      parts.references,
      parts.blur,
      parts.grants,
    );
    const result = await handler.execute({ ...query, limit: manyRows.length });
    expect(result.cards).toHaveLength(manyRows.length);
    expect(peak).toBe(4);
  });
});
