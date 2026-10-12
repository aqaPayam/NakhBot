import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionOwnedUnlockBatchResult = Readonly<{ purgedRows: number; hasMore: boolean }>;

/** Removes one deleted payer's closed unlock, preserving original financial proof. */
export class PostgresAccountDeletionOwnedUnlockStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async purgeNext(lease: AccountDeletionLease): Promise<DeletionOwnedUnlockBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    try {
      return await this.database.transaction().execute(async (tx) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const result =
          await sql<DeletionOwnedUnlockBatchResult>`SELECT purged_rows AS "purgedRows",has_more AS "hasMore"
          FROM interaction.purge_deletion_unlock_source(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,
            ${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(tx);
        if (result.rows.length !== 1) throw new Error('Deletion owned unlock batch result missing');
        return result.rows[0]!;
      });
    } catch {
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    }
  }
}
