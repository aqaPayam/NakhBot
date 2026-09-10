import type { AuthorizedMediaDelivery, MediaDeliveryAuthorizationPort } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function denied(): never {
  throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
}

export class PostgresMediaDeliveryAuthorization implements MediaDeliveryAuthorizationPort {
  public constructor(private readonly database: NakhDatabase) {}

  public async authorize(
    input: Parameters<MediaDeliveryAuthorizationPort['authorize']>[0],
  ): Promise<AuthorizedMediaDelivery> {
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
