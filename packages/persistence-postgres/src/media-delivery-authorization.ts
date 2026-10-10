import { randomUUID } from 'node:crypto';
import type { AuthorizedMediaDelivery, MediaDeliveryAuthorizationPort } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { actionableLikedByFrom } from './liked-by-store.js';

function denied(): never {
  throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export type MediaSourceAuthorityQuery = Readonly<{
  authorityId: string;
  audienceId: string;
  path: string;
  purpose: string;
  variant: string;
  issuedAt: number;
  expiresAt: number;
}>;

/** Native opaque receipts preserve the original source, rather than reauthorizing a path. */
export class PostgresMediaDeliveryAuthorization implements MediaDeliveryAuthorizationPort {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {}

  public async authorize(
    input: Parameters<MediaDeliveryAuthorizationPort['authorize']>[0],
  ): Promise<AuthorizedMediaDelivery> {
    const ttlSeconds = input.ttlSeconds ?? 60;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 300) denied();
    if (input.actor.kind !== 'user' || !UUID.test(input.actor.userId) || !UUID.test(input.photoId))
      denied();
    // Retained evidence is delivered only through the separately audited M7 path.
    const purpose = input.purpose;
    if (purpose !== 'owner_preview' && purpose !== 'liked_by_blur') denied();
    if (
      (purpose === 'owner_preview' && input.requestedVariant !== 'thumbnail') ||
      (purpose === 'liked_by_blur' && input.requestedVariant !== 'blurred_preview')
    )
      denied();
    try {
      return await this.database.transaction().execute(async (tx) => {
        const source =
          purpose === 'liked_by_blur'
            ? (
                await sql<{
                  owner_user_id: string;
                  photo_id: string;
                  asset_id: string;
                  like_id: string;
                }>`
              SELECT incoming.sender_user_id AS owner_user_id,primary_photo.id AS photo_id,
                primary_asset.id AS asset_id,incoming.id AS like_id
              ${actionableLikedByFrom(input.actor.userId)}
              AND primary_photo.id=${input.photoId}::uuid
              ORDER BY incoming.id LIMIT 1
            `.execute(tx)
              ).rows[0]
            : undefined;
        const owner =
          purpose === 'owner_preview'
            ? await tx
                .selectFrom('media.profile_photos as photo')
                .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
                .select([
                  'profile.user_id as owner_user_id',
                  'photo.id as photo_id',
                  'photo.asset_id',
                ])
                .where('photo.id', '=', input.photoId)
                .where('profile.user_id', '=', input.actor.userId)
                .executeTakeFirst()
            : source;
        if (owner === undefined) denied();
        const variant = await tx
          .selectFrom('media.photo_variants')
          .select(['id', 'delivery_path'])
          .where('asset_id', '=', owner.asset_id)
          .where('variant_type', '=', input.requestedVariant)
          .where('transformation_version', '=', 1)
          .where('deleted_at', 'is', null)
          .where('storage_deleted_at', 'is', null)
          .executeTakeFirst();
        if (variant === undefined) denied();
        const epochs = await tx
          .selectFrom('identity.accounts')
          .select(['user_id', 'product_epoch'])
          .where('user_id', 'in', [input.actor.userId, owner.owner_user_id])
          .execute();
        const actorEpoch = epochs.find((row) => row.user_id === input.actor.userId)?.product_epoch;
        const ownerEpoch = epochs.find((row) => row.user_id === owner.owner_user_id)?.product_epoch;
        if (actorEpoch === undefined || ownerEpoch === undefined) denied();
        // The insertion guard locks the original pair/identities and verifies all
        // facts again. Database issuance time is stamped only after lock waits.
        const receipt = await tx
          .insertInto('media.delivery_grants')
          .values({
            id: randomUUID(),
            actor_user_id: input.actor.userId,
            owner_user_id: owner.owner_user_id,
            actor_product_epoch: actorEpoch,
            owner_product_epoch: ownerEpoch,
            photo_id: owner.photo_id,
            asset_id: owner.asset_id,
            variant_id: variant.id,
            like_id: source?.like_id ?? null,
            purpose,
            variant_type: input.requestedVariant,
            delivery_path: variant.delivery_path,
            environment: this.environment,
            ttl_seconds: ttlSeconds,
          })
          .returning(['id', 'issued_at', 'expires_at'])
          .executeTakeFirstOrThrow();
        return {
          authorityId: receipt.id,
          issuedAt: Math.floor(receipt.issued_at.getTime() / 1000),
          expiresAt: Math.floor(receipt.expires_at.getTime() / 1000),
          deliveryPath: variant.delivery_path,
          variantType: input.requestedVariant,
          cachePolicy: 'no-store',
        };
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001')
        denied();
      throw error;
    }
  }

  public async isCurrent(input: MediaSourceAuthorityQuery): Promise<boolean> {
    if (
      !UUID.test(input.authorityId) ||
      !UUID.test(input.audienceId) ||
      !Number.isSafeInteger(input.issuedAt) ||
      !Number.isSafeInteger(input.expiresAt)
    )
      return false;
    const result = await sql<{ current: boolean }>`SELECT EXISTS (
      SELECT 1 FROM media.delivery_grants grant_row
      WHERE grant_row.id=${input.authorityId}::uuid AND grant_row.actor_user_id=${input.audienceId}::uuid
        AND grant_row.environment=${this.environment}
        AND grant_row.delivery_path=${input.path} AND grant_row.purpose=${input.purpose}
        AND grant_row.variant_type=${input.variant}
        AND grant_row.issued_at=to_timestamp(${input.issuedAt})
        AND grant_row.expires_at=to_timestamp(${input.expiresAt})
        AND clock_timestamp()>=grant_row.issued_at - interval '5 seconds'
        AND clock_timestamp()<grant_row.expires_at
        AND media.delivery_grant_source_is_current(grant_row)
    ) AS current`.execute(this.database);
    return result.rows[0]?.current === true;
  }
}
