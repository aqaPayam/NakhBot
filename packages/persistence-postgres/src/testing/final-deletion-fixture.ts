import { randomUUID } from 'node:crypto';
import type { AccountDeletionLease } from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import { createEphemeralDeletionFixture } from './ephemeral-deletion-fixture.js';
import { PostgresAccountDeletionSessionStore } from '../account-deletion-session-store.js';
import { PostgresAccountDeletionEphemeralStore } from '../account-deletion-ephemeral-store.js';
import { PostgresAccountDeletionRetentionStore } from '../account-deletion-retention-store.js';
import { PostgresAccountDeletionWorkStore } from '../account-deletion-work-store.js';

/** Real native phase 1..7 transitions. Empty provider observations are a native
 * fixture, not evidence of actual Redis absence or operator producer drain. */
export async function createFinalDeletionFixture(
  database: NakhDatabase,
  beforeDeletion?: (userId: string) => Promise<void>,
): Promise<{
  userId: string;
  recordId: string;
  lease: AccountDeletionLease;
}> {
  const item = await createEphemeralDeletionFixture(database, beforeDeletion);
  await new PostgresAccountDeletionSessionStore(database).revokeNext(item.lease);
  const ephemeral = new PostgresAccountDeletionEphemeralStore(
    database,
    'm8-native-final',
    'a'.repeat(64),
  );
  for (let n = 0; n < 6; n++) {
    const operation = (await ephemeral.claimNext(item.lease)).operation!;
    await ephemeral.complete(item.lease, operation.id, {
      cursor: operation.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
      more: false,
      found: 0,
    });
  }
  if (!(await ephemeral.finish(item.lease)).completed)
    throw new Error('Ephemeral fixture incomplete.');
  const work = new PostgresAccountDeletionWorkStore(database);
  const [retentionLease] = await work.claimDue({
    workerId: randomUUID(),
    limit: 1,
    leaseMs: 120000,
  });
  if (retentionLease?.deletionRecordId !== item.recordId)
    throw new Error('Unexpected retention fixture lease.');
  const retention = new PostgresAccountDeletionRetentionStore(database);
  while ((await retention.recordNext(retentionLease)).hasMore) {
    /* bounded */
  }
  if (!(await retention.finish(retentionLease)).completed)
    throw new Error('Retention fixture incomplete.');
  const [lease] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
  if (lease?.deletionRecordId !== item.recordId) throw new Error('Unexpected final fixture lease.');
  return { ...item, lease };
}
