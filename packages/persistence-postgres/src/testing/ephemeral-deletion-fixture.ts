import { randomUUID } from 'node:crypto';
import type { NakhDatabase } from '../database.js';
import { createDeletionFixture } from './deletion-fixture.js';
import { PostgresAccountDeletionWorkStore } from '../account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from '../account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from '../account-deletion-shared-store.js';
import { PostgresAccountDeletionProductStore } from '../account-deletion-product-store.js';
import { PostgresAccountDeletionTransportStore } from '../account-deletion-transport-store.js';
import { PostgresAccountDeletionReferencedLikeStore } from '../account-deletion-referenced-like-store.js';
import { PostgresAccountDeletionLikeStore } from '../account-deletion-like-store.js';
import { PostgresAccountDeletionFinancialStore } from '../account-deletion-financial-store.js';
import { PostgresAccountDeletionOperationalStore } from '../account-deletion-operational-store.js';
import type { AccountDeletionLease } from '@nakh/application';

export async function createEphemeralDeletionFixture(
  database: NakhDatabase,
  beforeDeletion?: (userId: string) => Promise<void>,
  beforeProductCheckpoint?: (lease: AccountDeletionLease) => Promise<void>,
  beforeEvidenceCheckpoint?: (lease: AccountDeletionLease) => Promise<void>,
): Promise<{ userId: string; recordId: string; lease: AccountDeletionLease }> {
  const item = await createDeletionFixture(database, beforeDeletion);
  const work = new PostgresAccountDeletionWorkStore(database),
    checkpoints = new PostgresAccountDeletionCheckpointStore(database);
  async function claim(): Promise<AccountDeletionLease> {
    const rows = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
    if (rows.length !== 1 || rows[0]!.deletionRecordId !== item.recordId)
      throw new Error('Unexpected native fixture lease.');
    return rows[0]!;
  }
  const shared = await claim();
  while ((await new PostgresAccountDeletionSharedStore(database).closeNext(shared)).hasMore) {
    /* bounded */
  }
  await checkpoints.finishShared(shared);
  const evidence = await claim();
  await beforeEvidenceCheckpoint?.(evidence);
  await checkpoints.finishEvidence(evidence);
  const product = await claim();
  while ((await new PostgresAccountDeletionProductStore(database).purgeNext(product)).hasMore) {
    /* bounded */
  }
  while ((await new PostgresAccountDeletionTransportStore(database).purgeNext(product)).hasMore) {
    /* bounded */
  }
  while (
    (await new PostgresAccountDeletionReferencedLikeStore(database).purgeNext(product)).hasMore
  ) {
    /* bounded */
  }
  while ((await new PostgresAccountDeletionLikeStore(database).purgeNext(product)).hasMore) {
    /* bounded */
  }
  await new PostgresAccountDeletionFinancialStore(database).prepareCreditEpoch(product);
  await new PostgresAccountDeletionOperationalStore(database).cancelNext(product);
  await beforeProductCheckpoint?.(product);
  if ((await checkpoints.finishProduct(product)).phase !== 'media_objects')
    throw new Error('Product fixture not verified.');
  if ((await checkpoints.finishMedia(await claim())).phase !== 'ephemeral_access')
    throw new Error('Media fixture not verified.');
  return { ...item, lease: await claim() };
}
