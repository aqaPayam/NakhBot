import { describe, expect, it } from 'vitest';

import type { CreateSampleEffectResult } from '@nakh/contracts';
import type { Clock, IdGenerator } from '@nakh/domain';

import { CreateSampleEffectHandler, type FoundationStore } from './index.js';

describe('CreateSampleEffectHandler', () => {
  it('supplies deterministic infrastructure values to the store', async () => {
    const expected: CreateSampleEffectResult = {
      effectId: '10000000-0000-4000-8000-000000000000',
      eventId: '20000000-0000-4000-8000-000000000000',
      name: 'sample',
      createdAt: '2026-09-01T00:00:00.000Z',
      replayed: false,
    };
    const store: FoundationStore = { createSampleEffect: () => Promise.resolve(expected) };
    const values = [expected.effectId, expected.eventId];
    const ids: IdGenerator = { uuid: () => values.shift() ?? 'unexpected' };
    const clock: Clock = { now: () => new Date(expected.createdAt) };
    const handler = new CreateSampleEffectHandler(store, ids, clock);

    const result = await handler.execute({
      commandId: '30000000-0000-4000-8000-000000000000',
      commandType: 'platform.create-sample-effect',
      schemaVersion: 1,
      actor: { userId: '40000000-0000-4000-8000-000000000000', kind: 'system' },
      requestId: '50000000-0000-4000-8000-000000000000',
      idempotencyKey: 'sample-key',
      occurredAt: expected.createdAt,
      locale: 'en',
      data: { name: 'sample' },
    });

    expect(result).toEqual(expected);
  });
});
