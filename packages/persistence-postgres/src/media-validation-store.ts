import { randomUUID } from 'node:crypto';

import { sql, type Transaction } from 'kysely';

import type { MediaValidationStore, PendingMediaValidation } from '@nakh/application';
import { ApplicationError, type AcceptedMediaType } from '@nakh/domain';

import type { DatabaseSchema, NakhDatabase } from './database.js';

type Tx = Transaction<DatabaseSchema>;
type RejectionCode =
  | 'media_too_large'
  | 'unsupported_media_type'
  | 'media_dimensions_invalid'
  | 'media_invalid'
  | 'duplicate_media'
  | 'photo_limit_reached';

function invalidValidation(): never {
  throw new ApplicationError('invalid_request', 'error.media.validation.invalid', 400);
}

function digest(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(value)) invalidValidation();
  return Buffer.from(value, 'hex');
}

export class PostgresMediaValidationStore implements MediaValidationStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {}

  public async claim(
    input: Readonly<{ assetId: string; owner: string; leaseMs: number }>,
  ): Promise<PendingMediaValidation | undefined> {
    if (
      !/^[\x20-\x7e]{1,128}$/u.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 900_000
    )
      throw new ApplicationError('invalid_request', 'error.media.lease.invalid', 400);
    const row = await this.database
      .updateTable('media.media_assets')
      .set({
        validation_lease_owner: input.owner,
        validation_lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
      })
      .where('id', '=', input.assetId)
      .where('validation_state', '=', 'pending')
      .where('quarantine_uploaded_at', 'is not', null)
      .where('malware_scan_result', '=', 'clean')
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('validation_lease_expires_at', 'is', null),
          eb('validation_lease_expires_at', '<', sql<Date>`clock_timestamp()`),
        ]),
      )
      .returning(['id', 'quarantine_key'])
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          assetId: row.id,
          quarantineKey: row.quarantine_key,
          validatedKey: `validated/${this.environment}/${row.id}/original`,
          thumbnailKey: `variants/${this.environment}/${row.id}/thumbnail-v1.webp`,
        };
  }

  public async complete(
    input: Readonly<{
      assetId: string;
      owner: string;
      detectedMediaType: AcceptedMediaType;
      sizeBytes: number;
      width: number;
      height: number;
      originalSha256: string;
      normalizedSha256: string;
      validatedKey: string;
      thumbnailKey: string;
      thumbnailBytes: number;
      thumbnailSha256: string;
      completedAt: Date;
    }>,
  ): Promise<'valid' | 'duplicate_media' | 'photo_limit_reached'> {
    const original = digest(input.originalSha256);
    const normalized = digest(input.normalizedSha256);
    const thumbnail = digest(input.thumbnailSha256);
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      !Number.isSafeInteger(input.thumbnailBytes) ||
      input.thumbnailBytes <= 0 ||
      !Number.isSafeInteger(input.width) ||
      input.width <= 0 ||
      !Number.isSafeInteger(input.height) ||
      input.height <= 0 ||
      input.validatedKey !== `validated/${this.environment}/${input.assetId}/original` ||
      input.thumbnailKey !== `variants/${this.environment}/${input.assetId}/thumbnail-v1.webp`
    )
      invalidValidation();

    return this.database.transaction().execute(async (tx) => {
      const identity = await tx
        .selectFrom('media.media_assets')
        .select('owner_user_id')
        .where('id', '=', input.assetId)
        .executeTakeFirst();
      if (identity === undefined)
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', identity.owner_user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const profile = await tx
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', identity.owner_user_id)
        .forUpdate()
        .executeTakeFirst();
      const asset = await tx
        .selectFrom('media.media_assets')
        .selectAll()
        .where('id', '=', input.assetId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        asset.validation_state !== 'pending' ||
        asset.validation_lease_owner !== input.owner ||
        asset.quarantine_uploaded_at === null ||
        asset.quarantine_size_bytes !== input.sizeBytes ||
        asset.quarantine_sha256 === null ||
        !asset.quarantine_sha256.equals(original)
      )
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);

      const photos =
        profile === undefined
          ? []
          : await tx
              .selectFrom('media.profile_photos')
              .selectAll()
              .where('profile_id', '=', profile.id)
              .where('status', '!=', 'deleted')
              .orderBy('id')
              .forUpdate()
              .execute();
      const duplicate = await tx
        .selectFrom('media.media_assets')
        .select('id')
        .where('owner_user_id', '=', asset.owner_user_id)
        .where('validation_state', '=', 'valid')
        .where('deleted_at', 'is', null)
        .where('normalized_sha256', '=', normalized)
        .where('id', '!=', input.assetId)
        .executeTakeFirst();
      const rejection: RejectionCode | undefined =
        duplicate !== undefined
          ? 'duplicate_media'
          : photos.length >= 6
            ? 'photo_limit_reached'
            : undefined;
      if (rejection !== undefined) {
        await this.rejectInTransaction(
          tx,
          input.assetId,
          input.owner,
          rejection,
          input.completedAt,
        );
        return rejection;
      }

      const updated = await tx
        .updateTable('media.media_assets')
        .set({
          validation_state: 'valid',
          error_code: null,
          detected_media_type: input.detectedMediaType,
          size_bytes: input.sizeBytes,
          width: input.width,
          height: input.height,
          frame_count: 1,
          original_sha256: original,
          normalized_sha256: normalized,
          validated_key: input.validatedKey,
          validated_at: input.completedAt,
          terminal_at: input.completedAt,
          validation_lease_owner: null,
          validation_lease_expires_at: null,
          version: sql<number>`version + 1`,
          updated_at: input.completedAt,
        })
        .where('id', '=', input.assetId)
        .where('validation_lease_owner', '=', input.owner)
        .returning('id')
        .executeTakeFirst();
      if (updated === undefined)
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
      await tx
        .insertInto('media.photo_variants')
        .values({
          id: randomUUID(),
          asset_id: input.assetId,
          variant_type: 'thumbnail',
          transformation_version: 1,
          storage_provider: 'r2',
          storage_key: input.thumbnailKey,
          delivery_path: `/media/${input.assetId}/thumbnail-v1.webp`,
          width: 512,
          height: 512,
          sha256: thumbnail,
          verified_at: input.completedAt,
          generated_at: input.completedAt,
          deleted_at: null,
          storage_deleted_at: null,
        })
        .execute();
      if (profile !== undefined) {
        const displayOrder = Math.max(-1, ...photos.map((photo) => photo.display_order)) + 1;
        await tx
          .insertInto('media.profile_photos')
          .values({
            id: randomUUID(),
            profile_id: profile.id,
            asset_id: input.assetId,
            status: 'visible',
            is_primary: photos.every((photo) => !photo.is_primary),
            display_order: displayOrder,
            created_at: input.completedAt,
            updated_at: input.completedAt,
            hidden_at: null,
            deleted_at: null,
          })
          .execute();
        const visibleCount = photos.filter((photo) => photo.status === 'visible').length + 1;
        if (profile.ever_completed)
          await tx
            .updateTable('profile.profiles')
            .set({
              completion_status: visibleCount >= 2 ? 'complete' : 'invalid',
              version: sql<number>`version + 1`,
              updated_at: input.completedAt,
            })
            .where('id', '=', profile.id)
            .execute();
      }
      await this.recordOutcome(
        tx,
        input.assetId,
        'media.photo-validated.v1',
        'valid',
        input.completedAt,
      );
      return 'valid';
    });
  }

  public async reject(
    input: Readonly<{
      assetId: string;
      owner: string;
      errorCode:
        'media_too_large' | 'unsupported_media_type' | 'media_dimensions_invalid' | 'media_invalid';
      rejectedAt: Date;
    }>,
  ): Promise<void> {
    await this.database
      .transaction()
      .execute((tx) =>
        this.rejectInTransaction(tx, input.assetId, input.owner, input.errorCode, input.rejectedAt),
      );
  }

  public async release(assetId: string, owner: string): Promise<void> {
    await this.database
      .updateTable('media.media_assets')
      .set({
        validation_lease_owner: null,
        validation_lease_expires_at: null,
      })
      .where('id', '=', assetId)
      .where('validation_lease_owner', '=', owner)
      .where('validation_state', '=', 'pending')
      .execute();
  }

  private async rejectInTransaction(
    tx: Tx,
    assetId: string,
    owner: string,
    errorCode: RejectionCode,
    at: Date,
  ): Promise<void> {
    const row = await tx
      .updateTable('media.media_assets')
      .set({
        validation_state: 'rejected',
        error_code: errorCode,
        terminal_at: at,
        validation_lease_owner: null,
        validation_lease_expires_at: null,
        version: sql<number>`version + 1`,
        updated_at: at,
      })
      .where('id', '=', assetId)
      .where('validation_state', '=', 'pending')
      .where('validation_lease_owner', '=', owner)
      .returning('id')
      .executeTakeFirst();
    if (row === undefined)
      throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
    await this.recordOutcome(tx, assetId, 'media.validation-rejected.v1', errorCode, at);
  }

  private async recordOutcome(
    tx: Tx,
    assetId: string,
    eventType: string,
    resultCode: string,
    at: Date,
  ): Promise<void> {
    const operationId = randomUUID();
    await tx
      .insertInto('platform.audit_logs')
      .values({
        id: randomUUID(),
        category: 'product',
        event_type: eventType,
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        subject_type: 'media_asset',
        subject_id: assetId,
        result_code: resultCode,
        metadata_schema_version: 1,
        metadata: { outcome: resultCode },
        request_id: operationId,
        command_id: operationId,
        occurred_at: at,
      })
      .execute();
    await tx
      .insertInto('platform.outbox_events')
      .values({
        id: randomUUID(),
        aggregate_type: 'media_asset',
        aggregate_id: assetId,
        event_type: eventType,
        schema_version: 1,
        payload: { assetId, resultCode },
        occurred_at: at,
        available_at: at,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: operationId,
        causation_id: operationId,
      })
      .execute();
  }
}
