import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import {
  DELETION_EPHEMERAL_STAGES,
  type AccountDeletionLease,
  type AccountDeletionEphemeralStore,
  type DeletionEphemeralCursor,
  type DeletionEphemeralOperation,
  type DeletionEphemeralObservation,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const PREPARED = 'account.deletion-ephemeral-prepared.v1';
function conflict(): never {
  throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Trusted deployment composition supplies the hash of actual operator drain
 * evidence. This is a recorded assertion, not a test or scan proving deployment
 * drain. It cannot be supplied by an own-account HTTP/Telegram command. */
export class PostgresAccountDeletionEphemeralStore implements AccountDeletionEphemeralStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public readonly namespaceHash: string;
  private readonly legacyNamespaceHash: string;
  private readonly queueHash: string;
  public constructor(
    private readonly database: NakhDatabase,
    prefix: string,
    private readonly cutoverEvidenceHash: string,
  ) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(prefix) ||
      !/^[0-9a-f]{64}$/u.test(cutoverEvidenceHash)
    )
      conflict();
    this.work = new PostgresAccountDeletionWorkStore(database);
    this.namespaceHash = hash(`m8-ephemeral-v1\0${prefix}`);
    this.legacyNamespaceHash = hash(`legacy-opaque-v1\0${prefix}`);
    this.queueHash = hash(`${prefix}:domain-events:`);
  }
  private validate(lease: AccountDeletionLease): void {
    if (!(
      (lease.phase === 'ephemeral_access' && lease.checkpointVersion === 5) ||
      (lease.phase === 'verification' && lease.checkpointVersion === 7)
    ))
      conflict();
  }
  private async configuration(tx: NakhDatabase, root: string): Promise<void> {
    assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
    const row = (
      await sql<{
        valid: boolean;
      }>`SELECT identity.ephemeral_history_valid(${root}::uuid) AND NOT EXISTS(
      SELECT 1 FROM platform.audit_logs a WHERE a.event_type=${PREPARED} AND a.subject_id=${root}::uuid AND (
        a.metadata->>'namespaceHash'<>${this.namespaceHash} OR a.metadata->>'legacyNamespaceHash'<>${this.legacyNamespaceHash}
        OR a.metadata->>'queueHash'<>${this.queueHash} OR a.metadata->>'cutoverEvidenceHash'<>${this.cutoverEvidenceHash})) AS valid`.execute(
        tx,
      )
    ).rows[0];
    if (row?.valid !== true) conflict();
  }
  public async claimNext(
    lease: AccountDeletionLease,
  ): Promise<Readonly<{ operation?: DeletionEphemeralOperation; done: boolean }>> {
    this.validate(lease);
    return this.work.withLease(lease, async (tx, scope) => {
      await this.configuration(tx, scope.deletionRecordId);
      const prior = (
        await sql<{
          id: string;
          revision: number;
          next_stage: number;
          next_cursor: DeletionEphemeralCursor;
          checkpoint: number;
        }>`SELECT p.id,p.revision,p.next_stage,p.next_cursor,coalesce((a.metadata->>'checkpointVersion')::integer,5) AS checkpoint
        FROM identity.account_deletion_ephemeral_pages p JOIN platform.audit_logs a ON a.id=p.id
        WHERE p.deletion_record_id=${scope.deletionRecordId}::uuid ORDER BY p.revision DESC LIMIT 1`.execute(
          tx,
        )
      ).rows[0];
      const restart =
        scope.checkpointVersion === 7 && prior?.next_stage === 6 && prior.checkpoint === 5;
      const stage = restart ? 0 : (prior?.next_stage ?? 0),
        revision = (prior?.revision ?? 0) + 1,
        cursor = restart ? '0' : (prior?.next_cursor ?? '0');
      if (stage === 6) return { done: true };
      const name = DELETION_EPHEMERAL_STAGES[stage];
      if (name === undefined) conflict();
      const busy = (
        await sql<{
          busy: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type=${PREPARED} AND subject_id=${scope.deletionRecordId}::uuid
        AND metadata->'revision'=to_jsonb(${revision}::integer) AND metadata->'generation'=to_jsonb(${scope.leaseGeneration}::integer)) AS busy`.execute(
          tx,
        )
      ).rows[0]!.busy;
      if (busy) return { done: false };
      const id = randomUUID();
      const row = (
        await sql<{
          epoch: number;
        }>`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
        SELECT ${id}::uuid,'account',${PREPARED},'system',NULL,NULL,'account_deletion',root.id,'prepared',1,
          jsonb_build_object('revision',${revision}::integer,'stage',${stage}::integer,'cursorHash',encode(sha256(convert_to(${JSON.stringify(cursor)}::jsonb::text,'UTF8')),'hex'),
            'previousId',${prior?.id ?? null}::uuid,'namespaceHash',${this.namespaceHash}::text,'legacyNamespaceHash',${this.legacyNamespaceHash}::text,'queueHash',${this.queueHash}::text,'cutoverEvidenceHash',${this.cutoverEvidenceHash}::text,
            'productEpoch',root.product_epoch,'owner',job.lease_owner,'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at,'transactionId',pg_current_xact_id()::text)
            || CASE WHEN ${scope.checkpointVersion}::integer=7 THEN jsonb_build_object('checkpointVersion',7) ELSE '{}'::jsonb END,root.command_id,root.request_id,clock_timestamp()
        FROM identity.account_deletion_records root JOIN identity.account_deletion_work job ON job.deletion_record_id=root.id WHERE root.id=${scope.deletionRecordId}::uuid RETURNING (metadata->>'productEpoch')::integer AS epoch`.execute(
          tx,
        )
      ).rows[0];
      if (row === undefined) conflict();
      return {
        done: false,
        operation: {
          id,
          deletionRecordId: scope.deletionRecordId,
          userId: scope.userId,
          productEpoch: row.epoch,
          namespaceHash: this.namespaceHash,
          cutoverEvidenceHash: this.cutoverEvidenceHash,
          stage: name,
          cursor,
        },
      };
    });
  }
  private async current(tx: NakhDatabase, lease: AccountDeletionLease, id: string): Promise<void> {
    const row = (
      await sql<{
        valid: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.id=${id}::uuid AND a.subject_id=${lease.deletionRecordId}::uuid
      AND a.metadata->>'namespaceHash'=${this.namespaceHash} AND a.metadata->>'cutoverEvidenceHash'=${this.cutoverEvidenceHash}
      AND a.metadata->>'owner'=${lease.leaseOwner} AND a.metadata->'generation'=to_jsonb(${lease.leaseGeneration}::integer)
      AND identity.ephemeral_operation_current(a.id)) AS valid`.execute(tx)
    ).rows[0];
    if (row?.valid !== true) conflict();
  }
  public async assertCurrent(lease: AccountDeletionLease, id: string): Promise<void> {
    this.validate(lease);
    await this.work.withLease(lease, async (tx, scope) => {
      await this.configuration(tx, scope.deletionRecordId);
      await this.current(tx, scope, id);
    });
  }
  public async complete(
    lease: AccountDeletionLease,
    id: string,
    observation: DeletionEphemeralObservation,
  ): Promise<void> {
    this.validate(lease);
    if (
      typeof observation.more !== 'boolean' ||
      !Number.isSafeInteger(observation.found) ||
      observation.found < 0 ||
      observation.found > 100
    )
      conflict();
    const cursor = JSON.stringify(observation.cursor),
      more = observation.more,
      found = observation.found;
    await this.work.withLease(lease, async (tx, scope) => {
      await this.configuration(tx, scope.deletionRecordId);
      await this.current(tx, scope, id);
      await sql`SELECT identity.record_ephemeral_page(${id}::uuid,${cursor}::jsonb,${more},${found})`.execute(
        tx,
      );
    });
  }
  public async finish(lease: AccountDeletionLease): Promise<Readonly<{ completed: boolean }>> {
    this.validate(lease);
    return this.database.transaction().execute(async (tx) => {
      await this.configuration(tx, lease.deletionRecordId);
      const row = (
        await sql<{
          phase: string;
          checkpoint: number;
          waiting: string | null;
        }>`SELECT phase,checkpoint_version AS checkpoint,waiting_for AS waiting FROM ${sql.raw(lease.checkpointVersion === 7 ? 'identity.finish_deletion_verification_phase' : 'identity.finish_deletion_ephemeral_phase')}(
        ${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration},${lease.checkpointVersion})`.execute(
          tx,
        )
      ).rows[0];
      if (row === undefined) conflict();
      if (row.phase === 'retention_manifest' && row.checkpoint === 6 && row.waiting === null)
        return { completed: true };
      if (row.phase === 'completed' && row.checkpoint === 8 && row.waiting === null)
        return { completed: true };
      if (row.phase === 'ephemeral_access' && row.checkpoint === 5 && row.waiting !== null)
        return { completed: false };
      if (row.phase === 'verification' && row.checkpoint === 7 && row.waiting !== null)
        return { completed: false };
      conflict();
    });
  }
}
