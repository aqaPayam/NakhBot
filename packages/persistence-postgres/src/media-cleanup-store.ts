import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { MediaCleanupStore, PendingMediaCleanup } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function invalidLease(): never {
  throw new ApplicationError('invalid_request', 'error.media.lease.invalid', 400);
}

export class PostgresMediaCleanupStore implements MediaCleanupStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async claimPhoto(
    input: Readonly<{ photoId: string; owner: string; leaseMs: number }>,
  ): Promise<PendingMediaCleanup | undefined> {
    if (
      !/^[\x20-\x7e]{1,128}$/u.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 900_000
    )
      invalidLease();
    return this.database.transaction().execute(async (tx) => {
      const photo = await tx
        .selectFrom('media.profile_photos')
        .select(['asset_id', 'status'])
        .where('id', '=', input.photoId)
        .executeTakeFirst();
      if (photo === undefined || photo.status !== 'deleted') return undefined;
      const asset = await tx
        .updateTable('media.media_assets')
        .set({
          cleanup_lease_owner: input.owner,
          cleanup_lease_expires_at: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
        })
        .where('id', '=', photo.asset_id)
        .where('deleted_at', 'is not', null)
        .where('storage_deleted_at', 'is', null)
        .where((expression) =>
          expression.or([
            expression('cleanup_lease_expires_at', 'is', null),
            expression('cleanup_lease_expires_at', '<', sql<Date>`clock_timestamp()`),
          ]),
        )
        .returning(['id', 'version', 'quarantine_key', 'validated_key'])
        .executeTakeFirst();
      if (asset === undefined) return undefined;
      const variants = await tx
        .selectFrom('media.photo_variants')
        .select(['storage_key', 'deleted_at'])
        .where('asset_id', '=', asset.id)
        .orderBy('storage_key')
        .execute();
      if (variants.some((variant) => variant.deleted_at === null))
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
      return {
        assetId: asset.id,
        deletionGeneration: asset.version,
        objectKeys: [
          ...variants.map((variant) => variant.storage_key),
          ...(asset.validated_key === null ? [] : [asset.validated_key]),
          asset.quarantine_key,
        ],
      };
    });
  }

  public async complete(
    input: Readonly<{
      assetId: string;
      deletionGeneration: number;
      owner: string;
      completedAt: Date;
    }>,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      const asset = await tx
        .selectFrom('media.media_assets')
        .select('id')
        .where('id', '=', input.assetId)
        .where('version', '=', input.deletionGeneration)
        .where('cleanup_lease_owner', '=', input.owner)
        .where('cleanup_lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .where('deleted_at', 'is not', null)
        .where('storage_deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (asset === undefined)
        throw new ApplicationError('version_conflict', 'error.media.cleanup.retry', 409);
      const variants = await tx
        .selectFrom('media.photo_variants')
        .select(['id', 'deleted_at'])
        .where('asset_id', '=', input.assetId)
        .forUpdate()
        .execute();
      if (variants.some((variant) => variant.deleted_at === null))
        throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
      await tx
        .updateTable('media.photo_variants')
        .set({ storage_deleted_at: input.completedAt })
        .where('asset_id', '=', input.assetId)
        .where('storage_deleted_at', 'is', null)
        .execute();
      await tx
        .updateTable('media.media_assets')
        .set({
          storage_deleted_at: input.completedAt,
          cleanup_lease_owner: null,
          cleanup_lease_expires_at: null,
          version: sql<number>`version + 1`,
          updated_at: input.completedAt,
        })
        .where('id', '=', input.assetId)
        .where('version', '=', input.deletionGeneration)
        .where('cleanup_lease_owner', '=', input.owner)
        .executeTakeFirstOrThrow();
      const operationId = randomUUID();
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: randomUUID(),
          category: 'product',
          event_type: 'media.asset-cleanup-completed.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'media_asset',
          subject_id: input.assetId,
          result_code: 'succeeded',
          metadata_schema_version: 1,
          metadata: { deletionGeneration: input.deletionGeneration },
          request_id: operationId,
          command_id: operationId,
          occurred_at: input.completedAt,
        })
        .execute();
      await tx
        .insertInto('platform.outbox_events')
        .values({
          id: randomUUID(),
          aggregate_type: 'media_asset',
          aggregate_id: input.assetId,
          event_type: 'media.asset-cleanup-completed.v1',
          schema_version: 1,
          payload: { assetId: input.assetId, deletionGeneration: input.deletionGeneration },
          occurred_at: input.completedAt,
          available_at: input.completedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: operationId,
          causation_id: operationId,
        })
        .execute();
    });
  }

  public async release(assetId: string, owner: string): Promise<void> {
    await this.database
      .updateTable('media.media_assets')
      .set({ cleanup_lease_owner: null, cleanup_lease_expires_at: null })
      .where('id', '=', assetId)
      .where('cleanup_lease_owner', '=', owner)
      .where('storage_deleted_at', 'is', null)
      .execute();
  }
}
