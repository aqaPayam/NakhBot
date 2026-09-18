import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import type { MarkNotInterestedCommand } from '@nakh/contracts';

import type { NakhDatabase } from './database.js';
import { PostgresInteractionStore } from './interaction-store.js';

it('rejects an unavailable interaction source through the Promise contract', async () => {
  const command: MarkNotInterestedCommand = {
    commandId: randomUUID(),
    commandType: 'interaction.mark-not-interested',
    schemaVersion: 1,
    actor: { kind: 'user', userId: randomUUID() },
    requestId: randomUUID(),
    idempotencyKey: `reject:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId: randomUUID(), source: 'liked_by' },
  };
  const generated: Parameters<PostgresInteractionStore['markNotInterested']>[1] = {
    rejectionId: randomUUID(),
    auditId: randomUUID(),
    rejectionEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    consumptionEventId: randomUUID(),
    occurredAt: new Date(),
  };
  const store = new PostgresInteractionStore({} as NakhDatabase);

  await expect(store.markNotInterested(command, generated)).rejects.toMatchObject({
    code: 'interaction_unavailable',
  });
});
