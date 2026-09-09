import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  BeginMediaIngestionWrite,
  MediaIngestionStore,
  MediaTransportCipher,
  PendingQuarantineAsset,
  QuarantineAssetStore,
} from '@nakh/application';
import type { BeginPhotoIngestionResult } from '@nakh/contracts';
import {
  ApplicationError,
  assertDeclaredUpload,
  assertUploadAttemptAvailable,
  MEDIA_LIMITS,
  evaluateCapability,
} from '@nakh/domain';
import type { NakhDatabase } from './database.js';

/** Persists intent only: no network I/O, no decoder, and no ability to mark an asset valid. */
export class PostgresMediaStore implements MediaIngestionStore, QuarantineAssetStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    private readonly transportCipher?: MediaTransportCipher,
  ) {}

  public async claimPendingQuarantine(
    input: Readonly<{ assetId: string; owner: string; leaseMs: number }>,
  ): Promise<PendingQuarantineAsset | undefined> {
    if (
      !/^[\x20-\x7e]{1,128}$/u.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1_000 ||
      input.leaseMs > 900_000
    )
      throw new ApplicationError('invalid_request', 'error.media.lease.invalid', 400);
    const completed = await this.database
      .selectFrom('media.media_assets')
      .select([
        'id',
        'quarantine_key',
        'transport_metadata_ciphertext',
        'quarantine_size_bytes',
        'quarantine_sha256',
        'quarantine_uploaded_at',
      ])
      .where('id', '=', input.assetId)
      .where('validation_state', '=', 'pending')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (completed === undefined) return undefined;
    if (
      completed.quarantine_uploaded_at !== null &&
      completed.quarantine_size_bytes !== null &&
      completed.quarantine_sha256 !== null
    )
      return {
        assetId: completed.id,
        quarantineKey: completed.quarantine_key,
        completed: {
          bytes: completed.quarantine_size_bytes,
          sha256: completed.quarantine_sha256.toString('hex'),
        },
      };
    const row = await this.database
      .updateTable('media.media_assets')
      .set({
        ingestion_lease_owner: input.owner,
        ingestion_lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
      })
      .where('id', '=', input.assetId)
      .where('validation_state', '=', 'pending')
      .where('quarantine_uploaded_at', 'is', null)
      .where('deleted_at', 'is', null)
      .where((expression) =>
        expression.or([
          expression('ingestion_lease_expires_at', 'is', null),
          expression('ingestion_lease_expires_at', '<', sql<Date>`clock_timestamp()`),
        ]),
      )
      .returning(['id', 'quarantine_key', 'transport_metadata_ciphertext'])
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (row.transport_metadata_ciphertext === null || this.transportCipher === undefined) {
      await this.releaseQuarantineClaim(row.id, input.owner);
      throw new ApplicationError(
        'dependency_unavailable',
        'error.media.transport_unavailable',
        503,
      );
    }
    let transport: Readonly<{ telegramFileId: string }>;
    try {
      transport = await this.transportCipher.decrypt(row.transport_metadata_ciphertext, row.id);
    } catch {
      await this.releaseQuarantineClaim(row.id, input.owner);
      throw new ApplicationError('invalid_request', 'error.media.transport_invalid', 400);
    }
    return {
      assetId: row.id,
      quarantineKey: row.quarantine_key,
      telegramFileId: transport.telegramFileId,
    };
  }

  public async markQuarantineUploaded(
    input: Readonly<{
      assetId: string;
      bytes: number;
      sha256: string;
      uploadedAt: Date;
      owner: string;
      scannerVersion: string;
      signatureVersion: string;
      scannedAt: Date;
    }>,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes <= 0 ||
      input.bytes > MEDIA_LIMITS.maximumUploadBytes ||
      !/^[a-f0-9]{64}$/u.test(input.sha256)
    )
      throw new ApplicationError('invalid_request', 'error.media.download.invalid', 400);
    if (
      !/^[\x20-\x7e]{1,128}$/u.test(input.scannerVersion) ||
      !/^[\x20-\x7e]{1,128}$/u.test(input.signatureVersion)
    )
      throw new ApplicationError('invalid_request', 'error.media.scan.invalid', 400);
    const digest = Buffer.from(input.sha256, 'hex');
    await this.database.transaction().execute(async (transaction) => {
      const updated = await transaction
        .updateTable('media.media_assets')
        .set({
          uploaded_at: input.uploadedAt,
          quarantine_uploaded_at: input.uploadedAt,
          quarantine_size_bytes: input.bytes,
          quarantine_sha256: digest,
          transport_metadata_ciphertext: null,
          ingestion_lease_owner: null,
          ingestion_lease_expires_at: null,
          malware_scan_result: 'clean',
          malware_scanner_version: input.scannerVersion,
          malware_signature_version: input.signatureVersion,
          malware_scanned_at: input.scannedAt,
          updated_at: input.uploadedAt,
        })
        .where('id', '=', input.assetId)
        .where('validation_state', '=', 'pending')
        .where('quarantine_uploaded_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where('ingestion_lease_owner', '=', input.owner)
        .returning('id')
        .executeTakeFirst();
      if (updated !== undefined) {
        await this.recordQuarantineOutcome(transaction, {
          assetId: input.assetId,
          eventType: 'media.quarantine-uploaded.v1',
          resultCode: 'uploaded',
          occurredAt: input.uploadedAt,
          payload: { assetId: input.assetId, bytes: input.bytes },
        });
        return;
      }
      const existing = await transaction
        .selectFrom('media.media_assets')
        .select(['quarantine_size_bytes', 'quarantine_sha256'])
        .where('id', '=', input.assetId)
        .executeTakeFirst();
      if (
        existing?.quarantine_size_bytes !== input.bytes ||
        existing.quarantine_sha256?.toString('hex') !== input.sha256
      )
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
    });
  }

  public async markDownloadRejected(
    input: Readonly<{
      assetId: string;
      errorCode: 'media_too_large' | 'media_download_invalid' | 'malware_detected';
      failedAt: Date;
      owner: string;
    }>,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const updated = await transaction
        .updateTable('media.media_assets')
        .set({
          validation_state: 'rejected',
          error_code: input.errorCode,
          terminal_at: input.failedAt,
          updated_at: input.failedAt,
          transport_metadata_ciphertext: null,
          ingestion_lease_owner: null,
          ingestion_lease_expires_at: null,
          malware_scan_result: null,
          malware_scanner_version: null,
          malware_signature_version: null,
          malware_scanned_at: null,
        })
        .where('id', '=', input.assetId)
        .where('validation_state', '=', 'pending')
        .where('quarantine_uploaded_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where('ingestion_lease_owner', '=', input.owner)
        .returning('id')
        .executeTakeFirst();
      if (updated !== undefined) {
        await this.recordQuarantineOutcome(transaction, {
          assetId: input.assetId,
          eventType: 'media.ingestion-rejected.v1',
          resultCode: input.errorCode,
          occurredAt: input.failedAt,
          payload: { assetId: input.assetId, errorCode: input.errorCode },
        });
        return;
      }
      const existing = await transaction
        .selectFrom('media.media_assets')
        .select('error_code')
        .where('id', '=', input.assetId)
        .executeTakeFirst();
      if (existing?.error_code !== input.errorCode)
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
    });
  }

  public async releaseQuarantineClaim(assetId: string, owner: string): Promise<void> {
    await this.database
      .updateTable('media.media_assets')
      .set({ ingestion_lease_owner: null, ingestion_lease_expires_at: null })
      .where('id', '=', assetId)
      .where('ingestion_lease_owner', '=', owner)
      .where('quarantine_uploaded_at', 'is', null)
      .execute();
  }

  private async recordQuarantineOutcome(
    transaction: NakhDatabase,
    input: Readonly<{
      assetId: string;
      eventType: string;
      resultCode: string;
      occurredAt: Date;
      payload: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void> {
    const operationId = randomUUID();
    await transaction
      .insertInto('platform.audit_logs')
      .values({
        id: randomUUID(),
        category: 'product',
        event_type: input.eventType,
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        subject_type: 'media_asset',
        subject_id: input.assetId,
        result_code: input.resultCode,
        metadata_schema_version: 1,
        metadata: {},
        request_id: operationId,
        command_id: operationId,
        occurred_at: input.occurredAt,
      })
      .execute();
    await transaction
      .insertInto('platform.outbox_events')
      .values({
        id: randomUUID(),
        aggregate_type: 'media_asset',
        aggregate_id: input.assetId,
        event_type: input.eventType,
        schema_version: 1,
        payload: input.payload,
        occurred_at: input.occurredAt,
        available_at: input.occurredAt,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: operationId,
        causation_id: operationId,
      })
      .execute();
  }

  public async beginTelegramIngestion(
    write: BeginMediaIngestionWrite,
  ): Promise<BeginPhotoIngestionResult> {
    const { command } = write;
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (
      write.transportMetadataCiphertext.length === 0 ||
      write.transportMetadataCiphertext.length > 8192
    )
      throw new ApplicationError('invalid_request', 'error.media.transport_invalid', 400);
    const userId = command.actor.userId;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          commandType: command.commandType,
          schemaVersion: command.schemaVersion,
          actor: command.actor,
          data: {
            telegramFileId: command.data.telegramFileId,
            telegramFileUniqueId: command.data.telegramFileUniqueId,
            declaredSizeBytes: command.data.declaredSizeBytes,
            declaredMediaType: command.data.declaredMediaType,
            originalFilename: command.data.originalFilename,
          },
        }),
      )
      .digest('hex');
    return this.database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined)
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      const existing = await transaction
        .selectFrom('platform.idempotency_records')
        .selectAll()
        .where('actor_user_id', '=', userId)
        .where('scope', '=', command.commandType)
        .where('idempotency_key', '=', command.idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return {
          ...(existing.response_json as unknown as BeginPhotoIngestionResult),
          replayed: true,
        };
      }
      const account = await transaction
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const allowed = evaluateCapability(
        { accountState: account.state, profileCompletion: null, visibilityEnabled: false },
        account.state === 'incomplete' ? 'continue_signup' : 'edit_profile',
      );
      if (!allowed.allowed)
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      // Read server time AFTER waiting for the per-User lock. Equal timestamps count too;
      // neither an old client timestamp nor a future stored attempt can evade the limit.
      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const now = time.rows[0]!.now;
      const attempts = await transaction
        .selectFrom('media.media_assets')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('owner_user_id', '=', userId)
        .where('attempted_at', '>=', new Date(now.getTime() - MEDIA_LIMITS.uploadAttemptWindowMs))
        .executeTakeFirstOrThrow();
      assertUploadAttemptAvailable(Number(attempts.count));
      let errorCode: 'media_too_large' | 'unsupported_media_type' | undefined;
      try {
        assertDeclaredUpload({
          ...(command.data.declaredSizeBytes === undefined
            ? {}
            : { sizeBytes: command.data.declaredSizeBytes }),
          ...(command.data.declaredMediaType === undefined
            ? {}
            : { mediaType: command.data.declaredMediaType }),
        });
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          (error.code !== 'media_too_large' && error.code !== 'unsupported_media_type')
        )
          throw error;
        errorCode = error.code;
      }
      const result: BeginPhotoIngestionResult =
        errorCode === undefined
          ? {
              assetId: write.assetId,
              validationState: 'pending',
              acceptedAt: now.toISOString(),
              replayed: false,
            }
          : {
              assetId: write.assetId,
              validationState: 'rejected',
              errorCode,
              acceptedAt: now.toISOString(),
              replayed: false,
            };
      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: userId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'completed',
          response_json: result,
          expires_at: new Date(now.getTime() + 86400000),
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined)
        throw new ApplicationError(
          'idempotency_conflict',
          'error.command.idempotency_conflict',
          409,
        );
      await transaction
        .insertInto('media.media_assets')
        .values({
          id: write.assetId,
          owner_user_id: userId,
          source_type: 'telegram',
          transport_metadata_ciphertext:
            errorCode === undefined ? Buffer.from(write.transportMetadataCiphertext) : null,
          validation_state: result.validationState,
          error_code: errorCode ?? null,
          detected_media_type: null,
          size_bytes: null,
          width: null,
          height: null,
          frame_count: null,
          original_sha256: null,
          normalized_sha256: null,
          storage_provider: 'r2',
          quarantine_key: `quarantine/${this.environment}/${write.assetId}/original`,
          validated_key: null,
          quarantine_size_bytes: null,
          quarantine_sha256: null,
          quarantine_uploaded_at: null,
          ingestion_lease_owner: null,
          ingestion_lease_expires_at: null,
          malware_scan_result: null,
          malware_scanner_version: null,
          malware_signature_version: null,
          malware_scanned_at: null,
          attempted_at: now,
          uploaded_at: null,
          validated_at: null,
          terminal_at: errorCode === undefined ? null : now,
          deleted_at: null,
          storage_deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const eventType =
        errorCode === undefined ? 'media.ingestion-requested.v1' : 'media.ingestion-rejected.v1';
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'product',
          event_type: eventType,
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'media_asset',
          subject_id: write.assetId,
          result_code: errorCode ?? 'accepted',
          metadata_schema_version: 1,
          metadata: { validationState: result.validationState },
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: now,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'media_asset',
          aggregate_id: write.assetId,
          event_type: eventType,
          schema_version: 1,
          payload: { assetId: write.assetId, validationState: result.validationState },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      return result;
    });
  }
}
