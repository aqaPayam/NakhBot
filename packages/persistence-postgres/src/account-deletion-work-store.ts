import { sql } from 'kysely';
import {
  ACCOUNT_DELETION_FAILURE_CODES,
  type AccountDeletionFailureCode,
  type AccountDeletionLease,
  type AccountDeletionWorkStore,
} from '@nakh/application';
import { ACCOUNT_DELETION_PHASES, ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
function leaseDuration(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 120_000) throw conflict();
}
function validate(lease: AccountDeletionLease): void {
  if (
    !UUID.test(lease.deletionRecordId) ||
    !UUID.test(lease.userId) ||
    !UUID.test(lease.leaseOwner) ||
    !ACCOUNT_DELETION_PHASES.includes(lease.phase) ||
    lease.phase === 'completed' ||
    !Number.isSafeInteger(lease.checkpointVersion) ||
    lease.checkpointVersion < 1 ||
    !Number.isSafeInteger(lease.leaseGeneration) ||
    lease.leaseGeneration < 1
  )
    throw conflict();
}
const LEASE_COLUMNS = sql`work.deletion_record_id AS "deletionRecordId", record.user_id AS "userId",
  work.phase, work.checkpoint_version AS "checkpointVersion", work.lease_owner AS "leaseOwner",
  work.lease_generation AS "leaseGeneration", work.lease_expires_at AS "leaseExpiresAt",
  work.attempt_count AS "attemptCount"`;

/** Mandatory work survives queue/cache loss. Internal leases never grant return or phase completion. */
export class PostgresAccountDeletionWorkStore implements AccountDeletionWorkStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async claimDue(input: {
    workerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AccountDeletionLease[]> {
    leaseDuration(input.leaseMs);
    if (
      !UUID.test(input.workerId) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw conflict();
    return this.database.transaction().execute(async (tx) => {
      const result = await sql<AccountDeletionLease>`WITH due AS MATERIALIZED (
        SELECT work.deletion_record_id FROM identity.account_deletion_work work
        JOIN identity.account_deletion_records record ON record.id=work.deletion_record_id
        JOIN identity.accounts account ON account.user_id=record.user_id
        WHERE work.phase<>'completed' AND record.completed_at IS NULL
          AND work.phase=record.phase AND work.checkpoint_version=record.checkpoint_version
          AND account.state='deleted' AND account.version=record.account_version
          AND work.available_at<=clock_timestamp()
          AND (work.lease_owner IS NULL OR work.lease_expires_at<=clock_timestamp())
        ORDER BY work.available_at,work.deletion_record_id LIMIT ${input.limit}
        FOR UPDATE OF work SKIP LOCKED
      ) UPDATE identity.account_deletion_work work
        SET lease_owner=${input.workerId}::uuid, lease_generation=work.lease_generation+1,
          attempt_count=work.attempt_count+1,
          lease_expires_at=clock_timestamp()+${input.leaseMs}*interval '1 millisecond'
        FROM due JOIN identity.account_deletion_records record ON record.id=due.deletion_record_id
        WHERE work.deletion_record_id=due.deletion_record_id RETURNING ${LEASE_COLUMNS}`.execute(
        tx,
      );
      return result.rows;
    });
  }

  private async current(
    tx: NakhDatabase,
    lease: AccountDeletionLease,
  ): Promise<AccountDeletionLease> {
    const row = (
      await sql<AccountDeletionLease>`SELECT ${LEASE_COLUMNS}
      FROM identity.account_deletion_work work
      JOIN identity.account_deletion_records record ON record.id=work.deletion_record_id
      JOIN identity.accounts account ON account.user_id=record.user_id
      WHERE work.deletion_record_id=${lease.deletionRecordId}::uuid AND record.user_id=${lease.userId}::uuid
        AND work.phase=${lease.phase} AND work.checkpoint_version=${lease.checkpointVersion}
        AND work.lease_owner=${lease.leaseOwner}::uuid AND work.lease_generation=${lease.leaseGeneration}
        AND work.lease_expires_at>clock_timestamp() AND record.completed_at IS NULL
        AND record.phase=work.phase AND record.checkpoint_version=work.checkpoint_version
        AND account.state='deleted' AND account.version=record.account_version`.execute(tx)
    ).rows[0];
    if (row === undefined) throw conflict();
    return row;
  }

  /** PostgreSQL-only bounded batch boundary. Provider requests must not run in this transaction.
   * Lock identity/account before record/work, then recheck the database clock after the callback.
   * An expired worker rolls back all batch writes, even while its row lock blocks a new claimant. */
  public async withLease<T>(
    lease: AccountDeletionLease,
    batch: (tx: NakhDatabase, scope: AccountDeletionLease) => Promise<T>,
  ): Promise<T> {
    return this.fencedTransaction(lease, batch);
  }

  private async fencedTransaction<T>(
    lease: AccountDeletionLease,
    batch: (tx: NakhDatabase, scope: AccountDeletionLease) => Promise<T>,
    settlement?: { code: AccountDeletionFailureCode | null; delaySeconds: number },
  ): Promise<T> {
    validate(lease);
    return this.database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', lease.userId)
        .forNoKeyUpdate()
        .execute();
      await tx
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', lease.userId)
        .forUpdate()
        .execute();
      const record = await sql<{ id: string }>`SELECT id FROM identity.account_deletion_records
        WHERE id=${lease.deletionRecordId}::uuid AND user_id=${lease.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (record.rows.length !== 1) throw conflict();
      await sql`SELECT deletion_record_id FROM identity.account_deletion_work
        WHERE deletion_record_id=${lease.deletionRecordId}::uuid FOR UPDATE`.execute(tx);
      const scope = await this.current(tx, lease);
      const result = await batch(tx, scope);
      await this.current(tx, lease);
      if (settlement !== undefined) {
        await sql`UPDATE identity.account_deletion_records SET last_error_code=${settlement.code}
          WHERE id=${lease.deletionRecordId}::uuid`.execute(tx);
        const cleared = await sql<{
          deletion_record_id: string;
        }>`UPDATE identity.account_deletion_work
          SET lease_owner=NULL,lease_expires_at=NULL,last_error_code=${settlement.code},
            available_at=clock_timestamp()+${settlement.delaySeconds}*interval '1 second'
          WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND lease_expires_at>clock_timestamp()
          RETURNING deletion_record_id`.execute(tx);
        if (cleared.rows.length !== 1) throw conflict();
      }
      return result;
    });
  }

  public async renew(lease: AccountDeletionLease, leaseMs: number): Promise<AccountDeletionLease> {
    leaseDuration(leaseMs);
    return this.withLease(lease, async (tx) => {
      await sql`UPDATE identity.account_deletion_work SET lease_expires_at=GREATEST(lease_expires_at,
        clock_timestamp()+${leaseMs}*interval '1 millisecond')
        WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(tx);
      return this.current(tx, lease);
    });
  }

  private async settle(
    lease: AccountDeletionLease,
    code: AccountDeletionFailureCode | null,
    delaySeconds: number,
  ): Promise<void> {
    await this.fencedTransaction(lease, () => Promise.resolve(), { code, delaySeconds });
  }

  public async release(lease: AccountDeletionLease): Promise<void> {
    await this.settle(lease, null, 0);
  }
  public async retry(
    lease: AccountDeletionLease,
    code: AccountDeletionFailureCode,
    delaySeconds: number,
  ): Promise<void> {
    if (
      !ACCOUNT_DELETION_FAILURE_CODES.includes(code) ||
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 1 ||
      delaySeconds > 3600
    )
      throw conflict();
    await this.settle(lease, code, delaySeconds);
  }
}
