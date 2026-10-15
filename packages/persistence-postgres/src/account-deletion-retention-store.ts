import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import type { AccountDeletionLease } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

function conflict(): never {
  throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** Durable descriptors and bounded original-row fingerprint inventory. Pending policy is neither an approved
 * indefinite period nor authority to release data, complete deletion or Return. */
export class PostgresAccountDeletionRetentionStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(private readonly database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private validate(lease: AccountDeletionLease): void {
    if (lease.phase !== 'retention_manifest' || lease.checkpointVersion !== 6) conflict();
  }
  public async recordNext(lease: AccountDeletionLease): Promise<Readonly<{ hasMore: boolean }>> {
    this.validate(lease);
    return this.work.withLease(lease, async (tx, scope) => {
      assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
      const row = (
        await sql<{ written: number }>`SELECT identity.record_retention_batch(
          ${scope.deletionRecordId}::uuid,${scope.userId}::uuid,${scope.leaseOwner}::uuid,${scope.leaseGeneration}) AS written`.execute(
          tx,
        )
      ).rows[0];
      if (row === undefined || row.written < 0 || row.written > 10) conflict();
      return { hasMore: row.written > 0 };
    });
  }
  public async finish(lease: AccountDeletionLease): Promise<Readonly<{ completed: boolean }>> {
    this.validate(lease);
    return this.database.transaction().execute(async (tx) => {
      assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
      const row = (
        await sql<{
          phase: string;
          checkpoint: number;
          waiting: string | null;
        }>`SELECT phase,checkpoint_version AS checkpoint,waiting_for AS waiting
        FROM identity.finish_deletion_retention_phase(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration},${lease.checkpointVersion})`.execute(
          tx,
        )
      ).rows[0];
      if (row?.phase === 'verification' && row.checkpoint === 7 && row.waiting === null)
        return { completed: true };
      if (row?.phase === 'retention_manifest' && row.checkpoint === 6 && row.waiting !== null)
        return { completed: false };
      conflict();
    });
  }
}
