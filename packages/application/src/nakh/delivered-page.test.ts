import { describe, expect, it, vi } from 'vitest';

import {
  GetNakhDetailHandler,
  GetNakhPageHandler,
  type DeliveredNakhReadStore,
} from './delivered-page.js';

const userId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const nakhId = '30000000-0000-4000-8000-000000000001';
const row = {
  nakhId,
  direction: 'received' as const,
  counterpartyName: 'Tree Friend',
  text: 'Hello',
  status: 'sent' as const,
  sentAt: new Date('2026-09-23T00:00:00.000Z'),
  expiresAt: new Date('2026-10-07T00:00:00.000Z'),
  version: 1,
};

describe('delivered Nakh read handlers', () => {
  it('maps authorized rows and issues a direction-bound next cursor', async () => {
    const store: DeliveredNakhReadStore = {
      readPage: vi.fn().mockResolvedValue({ totalCount: 2, rows: [row], hasMore: true }),
      readDetail: vi.fn().mockResolvedValue(row),
    };
    const references = {
      resolveCursor: vi.fn(),
      issueCursor: vi.fn().mockResolvedValue('v1.nk.abcdefghijklmnop.abcdefghijklmnop'),
    };
    const page = await new GetNakhPageHandler(store, references).received({
      actor: { kind: 'user', userId },
      requestId,
      limit: 1,
    });
    expect(page).toMatchObject({
      totalCount: 2,
      items: [{ nakhId, counterpartyName: 'Tree Friend', status: 'sent' }],
      nextCursor: 'v1.nk.abcdefghijklmnop.abcdefghijklmnop',
    });
    expect(references.issueCursor).toHaveBeenCalledWith(
      userId,
      'received',
      { sentAt: row.sentAt, nakhId },
      requestId,
    );
  });

  it('returns only the actor-authorized detail projection', async () => {
    const store: DeliveredNakhReadStore = {
      readPage: vi.fn(),
      readDetail: vi.fn().mockResolvedValue(row),
    };
    await expect(
      new GetNakhDetailHandler(store).execute({
        actor: { kind: 'user', userId },
        requestId,
        nakhId,
      }),
    ).resolves.toEqual({
      nakhId,
      direction: 'received',
      counterpartyName: 'Tree Friend',
      text: 'Hello',
      status: 'sent',
      sentAt: '2026-09-23T00:00:00.000Z',
      expiresAt: '2026-10-07T00:00:00.000Z',
      version: 1,
    });
  });
});
