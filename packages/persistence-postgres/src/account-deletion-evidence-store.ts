import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import {
  authenticateReportEvidenceInTransaction,
  type ReportEvidenceReaders,
} from './report-capture-integrity.js';

export type DeletionEvidenceBatch = Readonly<{
  examined: 0 | 1;
  verified: boolean;
  hasMore: boolean;
  waitingForCapture?: true;
}>;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** One persisted capture per fenced transaction. No plaintext leaves this store.
 * This records capture integrity only: source archival, provider object verification
 * and completion of the evidence phase require their separate verifiers. */
export class PostgresAccountDeletionEvidenceStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly readers: ReportEvidenceReaders,
  ) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private async next(tx: NakhDatabase, lease: AccountDeletionLease): Promise<string | undefined> {
    const result = await sql<{
      id: string;
    }>`SELECT evidence.id FROM moderation.report_evidence evidence
      JOIN moderation.reports report ON report.id=evidence.report_id
      WHERE ${lease.userId}::uuid IN (report.reporter_user_id,report.target_user_id)
        AND NOT EXISTS (SELECT 1 FROM identity.account_deletion_evidence_receipts receipt
          WHERE receipt.deletion_record_id=${lease.deletionRecordId}::uuid AND receipt.report_evidence_id=evidence.id)
      ORDER BY evidence.id LIMIT 1`.execute(tx);
    return result.rows[0]?.id;
  }
  public async verifyNext(lease: AccountDeletionLease): Promise<DeletionEvidenceBatch> {
    if (lease.phase !== 'evidence_capture' || lease.checkpointVersion !== 2) throw conflict();
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        const evidenceId = await this.next(tx, scope);
        if (evidenceId === undefined) {
          const changed =
            await sql`SELECT 1 FROM identity.account_deletion_evidence_receipts receipt
          LEFT JOIN LATERAL identity.deletion_evidence_capture(receipt.report_evidence_id) capture ON true
          WHERE receipt.deletion_record_id=${scope.deletionRecordId}::uuid
            AND (capture.snapshot_id IS DISTINCT FROM receipt.snapshot_id
              OR capture.fingerprint IS DISTINCT FROM receipt.capture_fingerprint
              OR capture.content_sha256 IS DISTINCT FROM receipt.content_sha256) LIMIT 1`.execute(
              tx,
            );
          if (changed.rows.length !== 0) throw conflict();
          return { examined: 0, verified: false, hasMore: false };
        }
        const capture = (
          await sql<{ snapshot_id: string; fingerprint: string; content_sha256: string }>`
        SELECT * FROM identity.deletion_evidence_capture(${evidenceId}::uuid)`.execute(tx)
        ).rows;
        if (capture.length === 0)
          return { examined: 1, verified: false, hasMore: true, waitingForCapture: true };
        if (capture.length !== 1) throw conflict();
        const prior = await sql`SELECT 1 FROM identity.account_deletion_evidence_receipts
        WHERE deletion_record_id=${scope.deletionRecordId}::uuid AND report_evidence_id=${evidenceId}::uuid`.execute(
          tx,
        );
        if (prior.rows.length !== 0) throw conflict();
        try {
          // The common reader authenticates AEAD/AAD or the complete typed-message
          // digest and validates photo/unmatch references. Never return its content.
          await authenticateReportEvidenceInTransaction(tx, this.readers, evidenceId);
        } catch {
          throw conflict();
        }
        const facts = (
          await sql<{ command_id: string; request_id: string; at: string }>`
        SELECT root.command_id,root.request_id,clock_timestamp()::text AS at
        FROM identity.account_deletion_records root JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
        WHERE root.id=${scope.deletionRecordId}::uuid`.execute(tx)
        ).rows[0]!;
        const auditId = randomUUID(),
          eventId = randomUUID(),
          item = capture[0]!;
        const audit =
          await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
        metadata_schema_version,metadata,command_id,request_id,occurred_at)
        VALUES(${auditId}::uuid,'account','account.deletion-evidence-verified.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
          'capture_verified',1,'{"kind":"capture_integrity"}'::jsonb,${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id`.execute(
            tx,
          );
        const event =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
        occurred_at,available_at,correlation_id,causation_id)
        VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-evidence-verified.v1',1,
          jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'kind','capture_integrity'),${facts.at},${facts.at},
          ${facts.request_id}::uuid,${facts.command_id}::uuid) RETURNING id`.execute(tx);
        const receipt =
          await sql`INSERT INTO identity.account_deletion_evidence_receipts(deletion_record_id,report_evidence_id,snapshot_id,
        capture_fingerprint,content_sha256,checklist_version,lease_owner,lease_generation,lease_expires_at,verified_at,audit_id,event_id)
        VALUES(${scope.deletionRecordId}::uuid,${evidenceId}::uuid,${item.snapshot_id}::uuid,${item.fingerprint},${item.content_sha256},1,
          ${scope.leaseOwner}::uuid,${scope.leaseGeneration},
          (SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid),
          ${facts.at},${auditId}::uuid,${eventId}::uuid)
        RETURNING report_evidence_id`.execute(tx);
        if (audit.rows.length !== 1 || event.rows.length !== 1 || receipt.rows.length !== 1)
          throw conflict();
        return { examined: 1, verified: true, hasMore: (await this.next(tx, scope)) !== undefined };
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw conflict();
    }
  }
}
