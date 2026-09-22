import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import type { NakhDatabase } from './database.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';

it('rejects invalid Pending Nakh page queries through its Promise contract', async () => {
  const store = new PostgresPendingNakhStore({} as NakhDatabase);
  const query = {
    actor: { kind: 'user' as const, userId: randomUUID() },
    requestId: randomUUID(),
    limit: 10,
  };
  await expect(
    store.readSenderPage({ ...query, actor: { ...query.actor, kind: 'admin' } }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(store.readSenderPage({ ...query, limit: 51 })).rejects.toMatchObject({
    code: 'invalid_request',
  });
});
