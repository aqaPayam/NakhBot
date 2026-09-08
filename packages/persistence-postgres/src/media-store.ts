import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { BeginMediaIngestionWrite, MediaIngestionStore } from '@nakh/application';
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
export class PostgresMediaStore implements MediaIngestionStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {}

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
