import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  AccountDeletionLease,
  AccountDeletionMediaOperation,
  AccountDeletionMediaStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

type Operation = Readonly<{
  id: string;
  asset_id: string;
  environment: string;
  kind: 'retain_photo' | 'delete_public';
  evidence_id: string | null;
  variant_id: string | null;
  key_role: string | null;
  variant_type: 'thumbnail' | 'blurred_preview' | null;
  transformation_version: number | null;
  source_sha256: string | null;
  verified_at: Date | null;
  verified_bytes: number | null;
}>;
function conflict(): never {
  throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
export class PostgresAccountDeletionMediaStore implements AccountDeletionMediaStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private validate(lease: AccountDeletionLease): void {
    if (lease.phase !== 'media_objects' || lease.checkpointVersion !== 4) conflict();
  }
  private async read(tx: NakhDatabase, root: string, id: string): Promise<Operation> {
    const rows = (
      await sql<Operation>`SELECT operation.*,variant.variant_type,variant.transformation_version,
      encode(variant.sha256,'hex') AS source_sha256 FROM identity.account_deletion_media_operations operation
      LEFT JOIN media.variant_reference_anchors variant ON variant.id=operation.variant_id
      WHERE operation.id=${id}::uuid AND operation.deletion_record_id=${root}::uuid`.execute(tx)
    ).rows;
    if (rows.length !== 1) conflict();
    return rows[0]!;
  }
  private result(lease: AccountDeletionLease, row: Operation): AccountDeletionMediaOperation {
    if (row.environment !== this.environment) conflict();
    const scope = {
      id: row.id,
      deletionRecordId: lease.deletionRecordId,
      userId: lease.userId,
      assetId: row.asset_id,
    };
    if (row.kind === 'retain_photo') {
      if (row.evidence_id === null || row.source_sha256 === null) conflict();
      return {
        ...scope,
        kind: 'retain_photo',
        evidenceId: row.evidence_id,
        sourceSha256: row.source_sha256,
      };
    }
    if (row.key_role === 'scope') return { ...scope, kind: 'verify_public_scope' };
    const prefix = `${this.environment}/${row.asset_id}`;
    if (row.key_role === 'quarantine' || row.key_role === 'validated')
      return {
        ...scope,
        kind: 'delete_public',
        key: `${row.key_role}/${prefix}/original`,
        deliveryPath: null,
      };
    if (row.variant_type === null || row.transformation_version === null) conflict();
    const filename = `${row.variant_type === 'thumbnail' ? 'thumbnail' : 'blurred-preview'}-v${row.transformation_version}.webp`;
    return {
      ...scope,
      kind: 'delete_public',
      key: `variants/${prefix}/${filename}`,
      deliveryPath: `/media/${row.asset_id}/${filename}`,
    };
  }
  private async assertHistory(tx: NakhDatabase, lease: AccountDeletionLease): Promise<void> {
    const invalid = (
      await sql<{ invalid: boolean }>`SELECT
      EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.deletion_record_id=${lease.deletionRecordId}::uuid
        AND operation.verified_at IS NOT NULL AND identity.deletion_media_operation_valid(operation) IS NOT TRUE)
      OR EXISTS(SELECT 1 FROM media.asset_reference_anchors asset WHERE asset.owner_user_id=${lease.userId}::uuid
        AND asset.product_epoch=(SELECT product_epoch FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid)
        AND NOT EXISTS(SELECT 1 FROM media.media_assets WHERE id=asset.id)
        AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_receipts receipt WHERE receipt.asset_id=asset.id AND identity.deletion_media_receipt_valid(receipt)))
      OR EXISTS(SELECT 1 FROM identity.account_deletion_media_receipts receipt JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
        WHERE root.user_id=${lease.userId}::uuid AND identity.deletion_media_receipt_valid(receipt) IS NOT TRUE)
      OR EXISTS(SELECT 1 FROM media.media_assets source WHERE source.owner_user_id=${lease.userId}::uuid
        AND NOT EXISTS(SELECT 1 FROM media.asset_reference_anchors anchor WHERE anchor.id=source.id AND anchor.owner_user_id=source.owner_user_id)) AS invalid`.execute(
        tx,
      )
    ).rows[0]!.invalid;
    if (invalid) conflict();
  }
  public async claimNext(
    lease: AccountDeletionLease,
  ): Promise<AccountDeletionMediaOperation | undefined> {
    this.validate(lease);
    return this.work.withLease(lease, async (tx, scope) => {
      assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
      await this.assertHistory(tx, scope);
      const pending = (
        await sql<{
          id: string;
        }>`SELECT operation.id FROM identity.account_deletion_media_operations operation
        WHERE operation.deletion_record_id=${scope.deletionRecordId}::uuid AND operation.verified_at IS NULL
        ORDER BY operation.prepared_at,operation.id LIMIT 1 FOR UPDATE`.execute(tx)
      ).rows[0];
      if (pending !== undefined) {
        await sql`UPDATE identity.account_deletion_media_operations operation SET lease_owner=job.lease_owner,
          lease_generation=job.lease_generation,lease_expires_at=job.lease_expires_at
          FROM identity.account_deletion_work job WHERE job.deletion_record_id=operation.deletion_record_id
            AND operation.id=${pending.id}::uuid`.execute(tx);
        return this.result(scope, await this.read(tx, scope.deletionRecordId, pending.id));
      }
      const source = (
        await sql<{ id: string }>`SELECT asset.id FROM media.media_assets asset
        WHERE asset.owner_user_id=${scope.userId}::uuid AND (
          NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations done WHERE done.asset_id=asset.id AND done.key_role='quarantine' AND done.verified_at IS NOT NULL)
          OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations done WHERE done.asset_id=asset.id AND done.key_role='validated' AND done.verified_at IS NOT NULL)
          OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations done WHERE done.asset_id=asset.id AND done.key_role='scope' AND done.verified_at IS NOT NULL)
          OR EXISTS(SELECT 1 FROM media.photo_variants variant WHERE variant.asset_id=asset.id AND NOT EXISTS(
            SELECT 1 FROM identity.account_deletion_media_operations done WHERE done.variant_id=variant.id AND done.kind='delete_public' AND done.verified_at IS NOT NULL)))
        AND (asset.ingestion_lease_expires_at IS NULL OR asset.ingestion_lease_expires_at<=clock_timestamp())
        AND (asset.validation_lease_expires_at IS NULL OR asset.validation_lease_expires_at<=clock_timestamp())
        AND (asset.cleanup_lease_expires_at IS NULL OR asset.cleanup_lease_expires_at<=clock_timestamp())
        ORDER BY asset.id LIMIT 1 FOR UPDATE`.execute(tx)
      ).rows[0];
      if (source === undefined) return undefined;
      await sql`UPDATE media.media_assets SET deleted_at=COALESCE(deleted_at,clock_timestamp()),
        version=version+CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END,transport_metadata_ciphertext=NULL,
        updated_at=clock_timestamp() WHERE id=${source.id}::uuid`.execute(tx);
      await sql`UPDATE media.photo_variants SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE asset_id=${source.id}::uuid`.execute(
        tx,
      );
      const hold = (
        await sql<{
          report_evidence_id: string;
          variant_id: string;
        }>`SELECT hold.report_evidence_id,hold.variant_id
        FROM media.report_photo_evidence_holds hold WHERE hold.asset_id=${source.id}::uuid
          AND identity.deletion_private_photo_valid(hold.report_evidence_id) IS NOT TRUE
        ORDER BY hold.report_evidence_id LIMIT 1`.execute(tx)
      ).rows[0];
      let kind: 'retain_photo' | 'delete_public' = 'delete_public',
        evidence: string | null = null,
        variant: string | null = null,
        role: string | null;
      if (hold !== undefined) {
        kind = 'retain_photo';
        evidence = hold.report_evidence_id;
        variant = hold.variant_id;
        role = null;
      } else {
        const originals = (
          await sql<{ quarantine: boolean; validated: boolean }>`SELECT
          EXISTS(SELECT 1 FROM identity.account_deletion_media_operations WHERE asset_id=${source.id}::uuid AND key_role='quarantine' AND verified_at IS NOT NULL) AS quarantine,
          EXISTS(SELECT 1 FROM identity.account_deletion_media_operations WHERE asset_id=${source.id}::uuid AND key_role='validated' AND verified_at IS NOT NULL) AS validated`.execute(
            tx,
          )
        ).rows[0]!;
        role = !originals.quarantine
          ? 'quarantine'
          : !originals.validated
            ? 'validated'
            : 'variant';
        if (role === 'variant') {
          variant =
            (
              await sql<{
                id: string;
              }>`SELECT variant.id FROM media.photo_variants variant WHERE variant.asset_id=${source.id}::uuid
            AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations done WHERE done.variant_id=variant.id AND done.kind='delete_public' AND done.verified_at IS NOT NULL)
            ORDER BY variant.id LIMIT 1`.execute(tx)
            ).rows[0]?.id ?? null;
          if (variant === null) role = 'scope';
        }
      }
      const id = randomUUID();
      const inserted =
        await sql`INSERT INTO identity.account_deletion_media_operations(id,deletion_record_id,asset_id,environment,kind,evidence_id,variant_id,key_role,
        prepared_at,lease_owner,lease_generation,lease_expires_at)
        SELECT ${id}::uuid,job.deletion_record_id,${source.id}::uuid,${this.environment},${kind},${evidence}::uuid,${variant}::uuid,${role},
          clock_timestamp(),job.lease_owner,job.lease_generation,job.lease_expires_at FROM identity.account_deletion_work job
        WHERE job.deletion_record_id=${scope.deletionRecordId}::uuid RETURNING id`.execute(tx);
      if (inserted.rows.length !== 1) conflict();
      return this.result(scope, await this.read(tx, scope.deletionRecordId, id));
    });
  }
  public async assertCurrent(lease: AccountDeletionLease, operationId: string): Promise<void> {
    this.validate(lease);
    await this.work.withLease(lease, async (tx, scope) => {
      const valid = (
        await sql<{ valid: boolean }>`SELECT identity.deletion_media_fence(operation) AS valid
        FROM identity.account_deletion_media_operations operation WHERE operation.id=${operationId}::uuid
          AND operation.deletion_record_id=${scope.deletionRecordId}::uuid AND operation.verified_at IS NULL`.execute(
          tx,
        )
      ).rows;
      if (valid.length !== 1 || valid[0]!.valid !== true) conflict();
    });
  }
  public async complete(
    lease: AccountDeletionLease,
    operationId: string,
    observation: Readonly<{ bytes: number | null; sha256: string | null }>,
  ): Promise<void> {
    this.validate(lease);
    await this.work.withLease(lease, async (tx, scope) => {
      const operation = await this.read(tx, scope.deletionRecordId, operationId);
      if (operation.verified_at !== null) {
        const valid = (
          await sql<{
            valid: boolean;
          }>`SELECT identity.deletion_media_operation_valid(operation) AS valid
          FROM identity.account_deletion_media_operations operation WHERE id=${operationId}::uuid`.execute(
            tx,
          )
        ).rows[0]?.valid;
        if (
          valid !== true ||
          (operation.kind === 'retain_photo' &&
            (observation.bytes === null ||
              observation.bytes !== operation.verified_bytes ||
              observation.sha256 !== operation.source_sha256)) ||
          (operation.kind === 'delete_public' &&
            (observation.bytes !== null || observation.sha256 !== null))
        )
          conflict();
        return;
      }
      if (operation.kind === 'retain_photo') {
        if (
          !Number.isSafeInteger(observation.bytes) ||
          observation.bytes === null ||
          observation.bytes < 1 ||
          observation.bytes > 10485760 ||
          observation.sha256 !== operation.source_sha256
        )
          conflict();
      } else if (observation.bytes !== null || observation.sha256 !== null) conflict();
      const audit = randomUUID(),
        event = randomUUID(),
        kind = operation.kind === 'retain_photo' ? 'media_copy' : 'media_delete';
      const metadata = JSON.stringify({
        kind,
        operationId,
        assetId: operation.asset_id,
        ...(operation.kind === 'retain_photo'
          ? { bytes: observation.bytes, sha256: observation.sha256 }
          : {}),
      });
      const proof = (
        await sql<{
          at: string;
        }>`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
        SELECT ${audit}::uuid,'account','account.deletion-media-operation.v1','system','account_deletion',root.id,'media_verified',1,${metadata}::jsonb,
          root.command_id,root.request_id,clock_timestamp() FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid RETURNING occurred_at::text AS at`.execute(
          tx,
        )
      ).rows;
      if (proof.length !== 1) conflict();
      const published =
        await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
        SELECT ${event}::uuid,'account_deletion',root.id,'account.deletion-media-operation.v1',1,
          jsonb_build_object('deletionRecordId',root.id,'operationId',${operationId}::uuid,'kind',${kind}::text),${proof[0]!.at}::timestamptz,${proof[0]!.at}::timestamptz,
          root.request_id,root.command_id FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid RETURNING id`.execute(
          tx,
        );
      const completed =
        await sql`UPDATE identity.account_deletion_media_operations SET verified_at=${proof[0]!.at}::timestamptz,
        verified_bytes=${observation.bytes},verified_sha256=${observation.sha256},verification_transaction=pg_current_xact_id(),audit_id=${audit}::uuid,event_id=${event}::uuid
        WHERE id=${operationId}::uuid AND verified_at IS NULL RETURNING id`.execute(tx);
      if (published.rows.length !== 1 || completed.rows.length !== 1) conflict();
    });
  }
  public async archiveNext(
    lease: AccountDeletionLease,
  ): Promise<Readonly<{ archived: boolean; hasMore: boolean }>> {
    this.validate(lease);
    return this.work.withLease(lease, async (tx, scope) => {
      assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
      await this.assertHistory(tx, scope);
      const source = (
        await sql<{
          id: string;
          version: number;
          digest: string;
          variants: number;
        }>`SELECT asset.id,asset.version,
        encode(sha256(convert_to(to_jsonb(asset)::text,'UTF8')),'hex') AS digest,
        (SELECT count(*)::integer FROM media.photo_variants WHERE asset_id=asset.id) AS variants
        FROM media.media_assets asset WHERE asset.owner_user_id=${scope.userId}::uuid
          AND identity.deletion_asset_provider_valid(asset.id) ORDER BY asset.id LIMIT 1 FOR UPDATE`.execute(
          tx,
        )
      ).rows[0];
      if (source !== undefined) {
        const audit = randomUUID(),
          event = randomUUID();
        const receipt = (
          await sql<{
            digest: string;
            at: string;
          }>`INSERT INTO identity.account_deletion_media_receipts AS receipt(asset_id,deletion_record_id,
          source_version,source_digest,variant_count,archived_at,lease_owner,lease_generation,lease_expires_at,batch_transaction,audit_id,event_id)
          SELECT ${source.id}::uuid,job.deletion_record_id,${source.version},${source.digest},${source.variants},clock_timestamp(),
            job.lease_owner,job.lease_generation,job.lease_expires_at,pg_current_xact_id(),${audit}::uuid,${event}::uuid
          FROM identity.account_deletion_work job WHERE job.deletion_record_id=${scope.deletionRecordId}::uuid
          RETURNING identity.deletion_media_receipt_digest(receipt) AS digest,archived_at::text AS at`.execute(
            tx,
          )
        ).rows;
        if (receipt.length !== 1) conflict();
        const recorded =
          await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
          SELECT ${audit}::uuid,'account','account.deletion-media-archived.v1','system','account_deletion',root.id,'media_archived',1,
            jsonb_build_object('kind','media_source','receiptDigest',${receipt[0]!.digest}::text),root.command_id,root.request_id,${receipt[0]!.at}::timestamptz
          FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid RETURNING id`.execute(
            tx,
          );
        const published =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
          SELECT ${event}::uuid,'account_deletion',root.id,'account.deletion-media-archived.v1',1,
            jsonb_build_object('deletionRecordId',root.id,'kind','media_source','assetId',${source.id}::uuid),${receipt[0]!.at}::timestamptz,${receipt[0]!.at}::timestamptz,
            root.request_id,root.command_id FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid RETURNING id`.execute(
            tx,
          );
        const variants =
          await sql`DELETE FROM media.photo_variants WHERE asset_id=${source.id}::uuid RETURNING id`.execute(
            tx,
          );
        const removed =
          await sql`DELETE FROM media.media_assets WHERE id=${source.id}::uuid RETURNING id`.execute(
            tx,
          );
        if (
          recorded.rows.length !== 1 ||
          published.rows.length !== 1 ||
          variants.rows.length !== source.variants ||
          removed.rows.length !== 1
        )
          conflict();
      }
      const remaining = (
        await sql<{
          remaining: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM media.media_assets WHERE owner_user_id=${scope.userId}::uuid) AS remaining`.execute(
          tx,
        )
      ).rows[0]!.remaining;
      return { archived: source !== undefined, hasMore: remaining };
    });
  }
}
