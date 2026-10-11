import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionLikeBatchResult = Readonly<{
  purgedRows: number;
  /** Original-life Likes only, never whole-product completion. */
  hasMore: boolean;
  waitingForReferences: boolean;
}>;

/** One canonically locked pair; at most its two unreferenced closed Likes.
 * Referenced identities, financial facts, safety captures and pair bans remain. */
export class PostgresAccountDeletionLikeStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async purgeNext(lease: AccountDeletionLease): Promise<DeletionLikeBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    try {
      return await this.database.transaction().execute(async (tx) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const result = await sql<DeletionLikeBatchResult>`SELECT
          purged_rows AS "purgedRows",has_more AS "hasMore",waiting_for_references AS "waitingForReferences"
          FROM interaction.purge_deletion_unreferenced_likes(
            ${lease.deletionRecordId}::uuid,${lease.userId}::uuid,
            ${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(tx);
        if (result.rows.length !== 1) throw new Error('Deletion Like batch result missing');
        return result.rows[0]!;
      });
    } catch {
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    }
  }
}
