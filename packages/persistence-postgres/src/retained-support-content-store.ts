import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

/** Internal bounded operation. Native deployment activation, exact original
 * membership, approved elapsed policy and mandatory audit remain authoritative. */
export class PostgresRetainedSupportContentStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async release(
    input: Readonly<{
      deletionRecordId: string;
      sourceAuditId: string;
      approvalId: string;
      expectedRootVersion: number;
    }>,
  ): Promise<Readonly<{ auditId: string }>> {
    const { deletionRecordId, sourceAuditId, approvalId, expectedRootVersion } = input;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
    if (
      ![deletionRecordId, sourceAuditId, approvalId].every((value) => uuid.test(value)) ||
      !Number.isSafeInteger(expectedRootVersion) ||
      expectedRootVersion < 0 ||
      expectedRootVersion > 2147483647
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const result = (
      await sql<{ auditId: string }>`SELECT support.release_content(
      ${deletionRecordId}::uuid,${sourceAuditId}::uuid,${approvalId}::uuid,${expectedRootVersion}::integer) AS "auditId"`.execute(
        this.database,
      )
    ).rows[0];
    if (result === undefined)
      throw new ApplicationError('conflict', 'error.deletion.unavailable', 409);
    return Object.freeze(result);
  }
}
