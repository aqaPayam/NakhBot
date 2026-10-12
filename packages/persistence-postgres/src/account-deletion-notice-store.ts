import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionNoticeBatchResult = Readonly<{
  purgedRows: number;
  hasMore: boolean;
  waitingForDelivery: boolean;
}>;
/** Ordinary message bodies are removed; minimum safety facts never render a notice. */
export class PostgresAccountDeletionNoticeStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async purgeNext(lease: AccountDeletionLease): Promise<DeletionNoticeBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    try {
      return await this.database.transaction().execute(async (tx) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const result =
          await sql<DeletionNoticeBatchResult>`SELECT purged_rows AS "purgedRows",has_more AS "hasMore",waiting_for_delivery AS "waitingForDelivery"
        FROM notification.purge_deletion_notice_source(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(
            tx,
          );
        if (result.rows.length !== 1) throw Error('Notice batch result missing');
        return result.rows[0]!;
      });
    } catch {
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    }
  }
}
