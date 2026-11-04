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
    const selected = Object.freeze(structuredClone(lease));
    this.validate(selected);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.recordSelected(selected);
      } catch (error) {
        // A lock timeout aborts this transaction, including all inventory/audit
        // writes. Retry only that transient condition, with a fresh transaction
        // and the original lease; native expiry/ownership checks run again.
        if (
          attempt >= 2 ||
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== '55P03'
        )
          throw error;
      }
    }
  }
  private async recordSelected(
    selected: AccountDeletionLease,
  ): Promise<Readonly<{ hasMore: boolean }>> {
    let schemaVersion: number | undefined;
    const requireVersion = async (tx: NakhDatabase): Promise<void> => {
      const row = (
        await sql<{ version: number }>`SELECT max(substring(name FROM 1 FOR 6)::integer) AS version
          FROM platform.schema_migrations`.execute(tx)
      ).rows[0];
      if (schemaVersion === undefined || row?.version !== schemaVersion) conflict();
    };
    return this.work.withLease(
      selected,
      async (tx, scope) => {
        await requireVersion(tx);
        const row = (
          await sql<{ written: number }>`SELECT identity.record_retention_batch(
          ${scope.deletionRecordId}::uuid,${scope.userId}::uuid,${scope.leaseOwner}::uuid,${scope.leaseGeneration}) AS written`.execute(
            tx,
          )
        ).rows[0];
        if (row === undefined || row.written < 0 || row.written > 10) conflict();
        await requireVersion(tx);
        return { hasMore: row.written > 0 };
      },
      async (tx) => {
        // Do not serialize the complete code-owned catalog projection behind every
        // duplicate worker. Native SQL independently checks the live catalog under
        // its identity/lease fence before writing; bind its ledger version too.
        const catalog = await readDeletionCatalog(tx);
        assertDeletionCatalogCoverage(catalog);
        schemaVersion = catalog.schemaVersion;
      },
    );
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
