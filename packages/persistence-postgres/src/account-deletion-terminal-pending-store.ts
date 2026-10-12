import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionTerminalPendingBatchResult = Readonly<{ purgedRows: number; hasMore: boolean }>;

/** One verified terminal unpaid body per transaction. Financial records and
 * original references remain; this does not finish phase 3 or grant return. */
export class PostgresAccountDeletionTerminalPendingStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async purgeNext(lease: AccountDeletionLease): Promise<DeletionTerminalPendingBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    try {
      return await this.database.transaction().execute(async (tx) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const result =
          await sql<DeletionTerminalPendingBatchResult>`SELECT purged_rows AS "purgedRows",has_more AS "hasMore"
          FROM nakh.purge_deletion_terminal_pending_source(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,
            ${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(tx);
        if (result.rows.length !== 1)
          throw new Error('Deletion terminal pending batch result missing');
        return result.rows[0]!;
      });
    } catch {
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    }
  }
}
