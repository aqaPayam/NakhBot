import type { AuthorizedMediaDelivery, MediaDeliveryAuthorizationPort } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';
import { actionableLikedByFrom } from './liked-by-store.js';

function denied(): never {
  throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
}

export class PostgresMediaDeliveryAuthorization implements MediaDeliveryAuthorizationPort {
  public constructor(private readonly database: NakhDatabase) {}

  public async authorize(
    input: Parameters<MediaDeliveryAuthorizationPort['authorize']>[0],
  ): Promise<AuthorizedMediaDelivery> {
    if (input.purpose === 'liked_by_blur') {
      if (input.actor.kind !== 'user' || input.requestedVariant !== 'blurred_preview') denied();
      const receiver = await this.database
        .selectFrom('identity.accounts as account')
        .innerJoin('identity.user_settings as settings', 'settings.user_id', 'account.user_id')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'account.user_id')
        .select(['account.state', 'settings.visibility_enabled', 'profile.completion_status'])
        .where('account.user_id', '=', input.actor.userId)
        .executeTakeFirst();
      if (
        receiver?.state !== 'active' ||
        receiver.completion_status !== 'complete' ||
        !receiver.visibility_enabled
      )
        denied();
      const result = await sql<{ delivery_path: string | null }>`
        SELECT (
          SELECT blurred.delivery_path
          FROM media.photo_variants blurred
          WHERE blurred.asset_id = primary_asset.id
            AND blurred.variant_type = 'blurred_preview'
            AND blurred.transformation_version = 1
            AND blurred.deleted_at IS NULL AND blurred.storage_deleted_at IS NULL
          LIMIT 1
        ) AS delivery_path
        ${actionableLikedByFrom(input.actor.userId)}
          AND primary_photo.id = ${input.photoId}::uuid
        LIMIT 1
      `.execute(this.database);
      const path = result.rows[0]?.delivery_path;
      if (path === undefined || path === null) denied();
      return { deliveryPath: path, variantType: 'blurred_preview', cachePolicy: 'no-store' };
    }
    if (input.requestedVariant !== 'thumbnail') denied();
    if (input.purpose === 'moderation_evidence') {
      if (input.actor.kind !== 'admin') denied();
      const admin = await this.database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', input.actor.userId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (admin === undefined) denied();
      const row = await this.database
        .selectFrom('media.profile_photos as photo')
        .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'photo.asset_id')
        .select('variant.delivery_path')
        .where('photo.id', '=', input.photoId)
        .where('variant.variant_type', '=', 'thumbnail')
        .where('variant.transformation_version', '=', 1)
        .where('variant.deleted_at', 'is', null)
        .where('variant.storage_deleted_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) denied();
      return { deliveryPath: row.delivery_path, variantType: 'thumbnail', cachePolicy: 'no-store' };
    }
    if (input.purpose !== 'owner_preview' || input.actor.kind !== 'user') denied();
    const row = await this.database
      .selectFrom('media.profile_photos as photo')
      .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
      .innerJoin('identity.accounts as account', 'account.user_id', 'profile.user_id')
      .innerJoin('media.media_assets as asset', 'asset.id', 'photo.asset_id')
      .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'asset.id')
      .select('variant.delivery_path')
      .where('photo.id', '=', input.photoId)
      .where('profile.user_id', '=', input.actor.userId)
      .where('account.state', 'in', ['active', 'restricted'])
      .where('photo.status', '!=', 'deleted')
      .where('asset.validation_state', '=', 'valid')
      .where('asset.deleted_at', 'is', null)
      .where('asset.storage_deleted_at', 'is', null)
      .where('variant.variant_type', '=', 'thumbnail')
      .where('variant.transformation_version', '=', 1)
      .where('variant.deleted_at', 'is', null)
      .where('variant.storage_deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) denied();
    return { deliveryPath: row.delivery_path, variantType: 'thumbnail', cachePolicy: 'private' };
  }
}
