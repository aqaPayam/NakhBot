import { randomUUID } from 'node:crypto';

import type { BlurGenerationStore } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function denied(): never {
  throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
}

export class PostgresBlurGenerationStore implements BlurGenerationStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {}

  public async prepare(assetId: string): ReturnType<BlurGenerationStore['prepare']> {
    const asset = await this.database
      .selectFrom('media.media_assets as asset')
      .innerJoin('media.profile_photos as photo', 'photo.asset_id', 'asset.id')
      .select(['asset.id', 'asset.validated_key'])
      .where('asset.id', '=', assetId)
      .where('asset.validation_state', '=', 'valid')
      .where('asset.deleted_at', 'is', null)
      .where('asset.storage_deleted_at', 'is', null)
      .where('photo.status', '=', 'visible')
      .where('photo.is_primary', '=', true)
      .where('photo.deleted_at', 'is', null)
      .executeTakeFirst();
    if (asset === undefined || asset.validated_key === null) denied();
    const existing = await this.database
      .selectFrom('media.photo_variants')
      .select('delivery_path')
      .where('asset_id', '=', assetId)
      .where('variant_type', '=', 'blurred_preview')
      .where('transformation_version', '=', 1)
      .where('deleted_at', 'is', null)
      .where('storage_deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing !== undefined) return { status: 'ready', deliveryPath: existing.delivery_path };
    return {
      status: 'pending',
      generation: {
        assetId,
        sourceKey: asset.validated_key,
        blurredKey: `variants/${this.environment}/${assetId}/blurred-preview-v1.webp`,
        deliveryPath: `/media/${assetId}/blurred-preview-v1.webp`,
      },
    };
  }

  public async complete(input: Parameters<BlurGenerationStore['complete']>[0]): Promise<string> {
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      input.blurredKey !== `variants/${this.environment}/${input.assetId}/blurred-preview-v1.webp`
    )
      throw new ApplicationError('invalid_request', 'error.media.validation.invalid', 400);
    return this.database.transaction().execute(async (tx) => {
      const assignment = await tx
        .selectFrom('media.profile_photos as photo')
        .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
        .select(['photo.id as photo_id', 'profile.id as profile_id', 'profile.user_id'])
        .where('photo.asset_id', '=', input.assetId)
        .executeTakeFirst();
      if (assignment === undefined) denied();
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', assignment.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await tx
        .selectFrom('profile.profiles')
        .select('id')
        .where('id', '=', assignment.profile_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const asset = await tx
        .selectFrom('media.media_assets')
        .select('id')
        .where('id', '=', input.assetId)
        .where('validation_state', '=', 'valid')
        .where('deleted_at', 'is', null)
        .where('storage_deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (asset === undefined) denied();
      const photo = await tx
        .selectFrom('media.profile_photos')
        .select('id')
        .where('id', '=', assignment.photo_id)
        .where('profile_id', '=', assignment.profile_id)
        .where('asset_id', '=', input.assetId)
        .where('status', '=', 'visible')
        .where('is_primary', '=', true)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (photo === undefined) denied();
      await tx
        .insertInto('media.photo_variants')
        .values({
          id: randomUUID(),
          asset_id: input.assetId,
          variant_type: 'blurred_preview',
          transformation_version: 1,
          storage_provider: 'r2',
          storage_key: input.blurredKey,
          delivery_path: `/media/${input.assetId}/blurred-preview-v1.webp`,
          width: 96,
          height: 96,
          sha256: Buffer.from(input.sha256, 'hex'),
          verified_at: input.completedAt,
          generated_at: input.completedAt,
          deleted_at: null,
          storage_deleted_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(['asset_id', 'variant_type', 'transformation_version']).doNothing(),
        )
        .execute();
      const result = await tx
        .selectFrom('media.photo_variants')
        .select(['delivery_path', 'storage_key', 'sha256'])
        .where('asset_id', '=', input.assetId)
        .where('variant_type', '=', 'blurred_preview')
        .where('transformation_version', '=', 1)
        .executeTakeFirstOrThrow();
      if (result.storage_key !== input.blurredKey || result.sha256.toString('hex') !== input.sha256)
        throw new ApplicationError('media_storage_mismatch', 'error.media.storage_mismatch', 409);
      return result.delivery_path;
    });
  }
}
