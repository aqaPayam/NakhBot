import { describe, expect, it, vi } from 'vitest';

import type { GetPendingNakhPageQuery } from '@nakh/contracts';

import { GetPendingNakhPageHandler, type PendingNakhReadStore } from './pending-page.js';
import type { PendingNakhOpaqueReferences } from './pending-tokens.js';

const senderUserId = '10000000-0000-4000-8000-000000000001';
const pendingNakhId = '20000000-0000-4000-8000-000000000001';
const query: GetPendingNakhPageQuery = {
  actor: { kind: 'user', userId: senderUserId },
  requestId: '30000000-0000-4000-8000-000000000001',
  limit: 1,
};
const createdAt = new Date('2026-09-22T00:00:00.000Z');
const row = {
  pendingNakhId,
  fundingIntentId: '20000000-0000-4000-8000-000000000002',
  targetName: 'Receiver',
  text: 'Private hello',
  createdAt,
  expiresAt: new Date('2026-10-06T00:00:00.000Z'),
  version: 1,
};

describe('GetPendingNakhPageHandler', () => {
  it('returns only the sender-safe projection and issues an actor-bound next cursor', async () => {
    const readSenderPage = vi.fn<PendingNakhReadStore['readSenderPage']>().mockResolvedValue({
      totalCount: 2,
      rows: [row],
      hasMore: true,
    });
    const issueCursor = vi.fn().mockResolvedValue('v1.pn.abcdefghijklmnop.ponmlkjihgfedcba');
    const references = {
      resolveCursor: vi.fn(),
      issueCursor,
    } as unknown as Pick<PendingNakhOpaqueReferences, 'resolveCursor' | 'issueCursor'>;
    const result = await new GetPendingNakhPageHandler({ readSenderPage }, references).execute(
      query,
    );
    expect(result).toEqual({
      totalCount: 2,
      items: [
        {
          pendingNakhId,
          fundingIntentId: row.fundingIntentId,
          targetName: 'Receiver',
          text: 'Private hello',
          status: 'pending_payment',
          createdAt: '2026-09-22T00:00:00.000Z',
          expiresAt: '2026-10-06T00:00:00.000Z',
          version: 1,
        },
      ],
      nextCursor: 'v1.pn.abcdefghijklmnop.ponmlkjihgfedcba',
    });
    expect(issueCursor).toHaveBeenCalledWith(
      senderUserId,
      { createdAt, pendingNakhId },
      query.requestId,
    );
  });

  it('resolves the cursor for the actor and fails closed for invalid references', async () => {
    const readSenderPage = vi.fn<PendingNakhReadStore['readSenderPage']>().mockResolvedValue({
      totalCount: 0,
      rows: [],
      hasMore: false,
    });
    const position = { createdAt, pendingNakhId };
    const references = {
      resolveCursor: vi.fn().mockResolvedValue(position),
      issueCursor: vi.fn(),
    } as unknown as Pick<PendingNakhOpaqueReferences, 'resolveCursor' | 'issueCursor'>;
    const handler = new GetPendingNakhPageHandler({ readSenderPage }, references);
    const cursor = 'v1.pn.abcdefghijklmnop.ponmlkjihgfedcba';
    await handler.execute({ ...query, cursor });
    expect(references.resolveCursor).toHaveBeenCalledWith(cursor, senderUserId);
    expect(readSenderPage).toHaveBeenCalledWith({ ...query, cursor }, position);

    references.resolveCursor = vi.fn().mockResolvedValue(undefined);
    await expect(handler.execute({ ...query, cursor })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects non-user actors before reading any sender data', async () => {
    const readSenderPage = vi.fn<PendingNakhReadStore['readSenderPage']>();
    const references = {
      resolveCursor: vi.fn(),
      issueCursor: vi.fn(),
    } as unknown as Pick<PendingNakhOpaqueReferences, 'resolveCursor' | 'issueCursor'>;
    await expect(
      new GetPendingNakhPageHandler({ readSenderPage }, references).execute({
        ...query,
        actor: { ...query.actor, kind: 'admin' },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(readSenderPage).not.toHaveBeenCalled();
  });
});
