import { describe, expect, it, vi } from 'vitest';

import { GetNextExploreCandidateHandler, SaveExploreFilterHandler } from './discovery.js';

const ids = { uuid: vi.fn(() => '10000000-0000-4000-8000-000000000000') };
const clock = { now: () => new Date('2026-09-16T00:00:00.000Z') };

describe('M3 discovery application ports', () => {
  it('passes generated durable identities to the filter transaction', async () => {
    const saveFilter = vi.fn().mockResolvedValue({ version: 1, replayed: false });
    const handler = new SaveExploreFilterHandler({ saveFilter, reserveNext: vi.fn() }, ids, clock);
    const command = {
      commandId: '20000000-0000-4000-8000-000000000000',
      commandType: 'discovery.save-explore-filter' as const,
      schemaVersion: 1 as const,
      actor: { kind: 'user' as const, userId: '30000000-0000-4000-8000-000000000000' },
      requestId: '40000000-0000-4000-8000-000000000000',
      idempotencyKey: 'filter-command',
      occurredAt: '2026-09-16T00:00:00.000Z',
      locale: 'en',
      data: {
        targetGenderOptionIds: ['50000000-0000-4000-8000-000000000000'],
        minAge: 20,
        maxAge: 40,
        cityId: '60000000-0000-4000-8000-000000000000',
      },
    };
    await handler.execute(command);
    expect(saveFilter).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        auditId: '10000000-0000-4000-8000-000000000000',
        eventId: '10000000-0000-4000-8000-000000000000',
        processedAt: clock.now(),
      }),
    );
  });

  it('rejects a non-user candidate query before storage', async () => {
    const reserveNext = vi.fn();
    const handler = new GetNextExploreCandidateHandler(
      { saveFilter: vi.fn(), reserveNext },
      ids,
      clock,
    );
    expect(() =>
      handler.execute({
        actor: { kind: 'system', userId: '30000000-0000-4000-8000-000000000000' },
        requestId: '40000000-0000-4000-8000-000000000000',
        mode: 'explore',
      }),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
    expect(reserveNext).not.toHaveBeenCalled();
  });
});
