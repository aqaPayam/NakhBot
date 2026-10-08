import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

type SharedCheckpointResult = Readonly<{
  phase: 'evidence_capture';
  checkpointVersion: 2;
  replayed: boolean;
}>;
const EVIDENCE_BLOCKERS = [
  'shared_scopes',
  'report_window',
  'captures',
  'profile_sources',
  'photo_sources',
  'chat_sources',
  'match_sources',
] as const;
export type EvidenceCheckpointResult =
  | Readonly<{ phase: 'product_data'; checkpointVersion: 3; replayed: boolean }>
  | Readonly<{
      phase: 'evidence_capture';
      checkpointVersion: 2;
      replayed: false;
      waitingFor: (typeof EVIDENCE_BLOCKERS)[number];
    }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}

/** The database owns verification, immutable receipts, audit/event and both checkpoint updates.
 * No provider request runs while identity/work locks are held. Only verified shared
 * closure and evidence/source completion can advance; later phases stay disabled. */
export class PostgresAccountDeletionCheckpointStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async finishShared(lease: AccountDeletionLease): Promise<SharedCheckpointResult> {
    if (
      !UUID.test(lease.deletionRecordId) ||
      !UUID.test(lease.userId) ||
      !UUID.test(lease.leaseOwner) ||
      lease.phase !== 'shared_closure' ||
      lease.checkpointVersion !== 1 ||
      !Number.isSafeInteger(lease.leaseGeneration) ||
      lease.leaseGeneration < 1
    )
      throw conflict();
    try {
      const result =
        await sql<SharedCheckpointResult>`SELECT phase,checkpoint_version AS "checkpointVersion",replayed
        FROM identity.finish_deletion_shared_phase(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,
          ${lease.leaseOwner}::uuid,${lease.leaseGeneration},${lease.checkpointVersion})`.execute(
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

  public async finishEvidence(lease: AccountDeletionLease): Promise<EvidenceCheckpointResult> {
    if (
      !UUID.test(lease.deletionRecordId) ||
      !UUID.test(lease.userId) ||
      !UUID.test(lease.leaseOwner) ||
      lease.phase !== 'evidence_capture' ||
      lease.checkpointVersion !== 2 ||
      !Number.isSafeInteger(lease.leaseGeneration) ||
      lease.leaseGeneration < 1
    )
      throw conflict();
    try {
      const row = (
        await sql<{
          phase: string;
          checkpointVersion: number;
          replayed: boolean;
          waitingFor: string | null;
        }>`SELECT phase,checkpoint_version AS "checkpointVersion",replayed,waiting_for AS "waitingFor"
          FROM identity.finish_deletion_evidence_phase(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,
            ${lease.leaseOwner}::uuid,${lease.leaseGeneration},${lease.checkpointVersion})`.execute(
          this.database,
        )
      ).rows;
      if (row.length !== 1) throw conflict();
      const result = row[0]!;
      if (
        result.phase === 'product_data' &&
        result.checkpointVersion === 3 &&
        result.waitingFor === null
      )
        return { phase: 'product_data', checkpointVersion: 3, replayed: result.replayed };
      const waitingFor = EVIDENCE_BLOCKERS.find((code) => code === result.waitingFor);
      if (
        result.phase === 'evidence_capture' &&
        result.checkpointVersion === 2 &&
        !result.replayed &&
        waitingFor !== undefined
      )
        return { phase: 'evidence_capture', checkpointVersion: 2, replayed: false, waitingFor };
      throw conflict();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001')
        throw conflict();
      throw error;
    }
  }
}
