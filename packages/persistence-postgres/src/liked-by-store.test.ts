import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import type { NakhDatabase } from './database.js';
import { PostgresLikedByStore } from './liked-by-store.js';

it('rejects invalid Liked By queries through its Promise contract', async () => {
  const store = new PostgresLikedByStore({} as NakhDatabase);
  const query = {
    actor: { kind: 'user' as const, userId: randomUUID() },
    requestId: randomUUID(),
    limit: 10,
  };
  await expect(
    store.readActionablePage({ ...query, actor: { ...query.actor, kind: 'admin' } }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(store.readActionablePage({ ...query, limit: 51 })).rejects.toMatchObject({
    code: 'invalid_request',
  });
});
