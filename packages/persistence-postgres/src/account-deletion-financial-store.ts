import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}

/** Internal phase-3 financial cutover. Keeps every original credit fact; no
 * whole-purge completion, return permission, cash refund or policy release. */
export class PostgresAccountDeletionFinancialStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async prepareCreditEpoch(
    lease: AccountDeletionLease,
  ): Promise<Readonly<{ replayed: boolean }>> {
    if (
      !UUID.test(lease.deletionRecordId) ||
      !UUID.test(lease.userId) ||
      !UUID.test(lease.leaseOwner) ||
      lease.phase !== 'product_data' ||
      lease.checkpointVersion !== 3 ||
      !Number.isSafeInteger(lease.leaseGeneration) ||
      lease.leaseGeneration < 1
    )
      throw conflict();
    try {
      const result = await sql<{
        replayed: boolean;
      }>`SELECT replayed FROM billing.prepare_deletion_credit_epoch(
        ${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration},${lease.checkpointVersion})`.execute(
        this.database,
      );
      if (result.rows.length !== 1) throw conflict();
      return result.rows[0]!;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001')
        throw conflict();
      throw error;
    }
  }
}
