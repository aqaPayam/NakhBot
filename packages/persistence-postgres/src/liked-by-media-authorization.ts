import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  AuthorizedMediaDelivery,
  MediaDeliveryAuthorizationPort,
  UserSessionActor,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { actionableLikedByFrom } from './liked-by-store.js';
import { lockUserPair, lockUserPairAccounts } from './pair-lock.js';
import { requireCurrentUserSession } from './user-session-store.js';
import {
  PostgresMediaDeliveryAuthorization,
  type MediaSourceAuthorityQuery,
} from './media-delivery-authorization.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function denied(): never {
  throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
}

/** Interactive Like media never selects a newer Like, unlock or user grant.
 * The native insert guard rechecks the same source after canonical lock waits. */
export class PostgresLikedByMediaAuthorization implements MediaDeliveryAuthorizationPort {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    owner: UserSessionActor,
    private readonly likeId: string,
    private readonly unlockId?: string,
  ) {
    this.owner = Object.freeze({ ...owner });
    if (!UUID.test(likeId) || (unlockId !== undefined && !UUID.test(unlockId))) denied();
  }
  public async authorize(
    request: Parameters<MediaDeliveryAuthorizationPort['authorize']>[0],
  ): Promise<AuthorizedMediaDelivery> {
    const input = structuredClone(request),
      ttl = input.ttlSeconds ?? 60;
    if (
      input.actor.kind !== 'user' ||
      input.actor.userId !== this.owner.userId ||
      !UUID.test(input.photoId) ||
      !Number.isSafeInteger(ttl) ||
      ttl < 10 ||
      ttl > 300
    )
      denied();
    const full = input.purpose === 'profile_detail';
    if (
      full
        ? this.unlockId === undefined || input.requestedVariant !== 'thumbnail'
        : input.purpose !== 'liked_by_blur' ||
          this.unlockId !== undefined ||
          input.requestedVariant !== 'blurred_preview'
    )
      denied();
    try {
      return await this.database.transaction().execute(async (tx) => {
        const like = (
          await sql<{
            ownerId: string;
            primaryPhotoId: string;
          }>`SELECT incoming.sender_user_id AS "ownerId",primary_photo.id AS "primaryPhotoId"
          ${actionableLikedByFrom(this.owner.userId)} AND incoming.id=${this.likeId}::uuid`.execute(
            tx,
          )
        ).rows[0];
        if (!like || (!full && input.photoId !== like.primaryPhotoId)) denied();
        const pair = await lockUserPair(tx, this.owner.userId, like.ownerId);
        await lockUserPairAccounts(tx, pair);
        await requireCurrentUserSession(tx, this.owner.userId, this.owner);
        const photo = await tx
          .selectFrom('media.profile_photos as p')
          .innerJoin('profile.profiles as owner', 'owner.id', 'p.profile_id')
          .innerJoin('media.photo_variants as v', 'v.asset_id', 'p.asset_id')
          .select(['p.id', 'p.asset_id', 'v.id as variantId', 'v.delivery_path'])
          .where('p.id', '=', input.photoId)
          .where('owner.user_id', '=', like.ownerId)
          .where('p.status', '=', 'visible')
          .where('p.deleted_at', 'is', null)
          .where('v.variant_type', '=', input.requestedVariant)
          .where('v.transformation_version', '=', 1)
          .where('v.deleted_at', 'is', null)
          .where('v.storage_deleted_at', 'is', null)
          .executeTakeFirst();
        if (!photo) denied();
        const target = await tx
          .selectFrom('identity.accounts')
          .select('product_epoch')
          .where('user_id', '=', like.ownerId)
          .executeTakeFirst();
        if (!target) denied();
        const receipt = await tx
          .insertInto('media.delivery_grants')
          .values({
            id: randomUUID(),
            actor_user_id: this.owner.userId,
            owner_user_id: like.ownerId,
            actor_product_epoch: this.owner.productEpoch,
            owner_product_epoch: target.product_epoch,
            photo_id: photo.id,
            asset_id: photo.asset_id,
            variant_id: photo.variantId,
            like_id: this.likeId,
            candidate_delivery_id: null,
            session_grant_id: this.owner.sessionGrantId,
            feature_unlock_id: full ? this.unlockId! : null,
            purpose: full ? 'profile_detail' : 'liked_by_blur',
            variant_type: input.requestedVariant,
            delivery_path: photo.delivery_path,
            environment: this.environment,
            ttl_seconds: ttl,
          })
          .returning(['id', 'issued_at', 'expires_at'])
          .executeTakeFirstOrThrow();
        return {
          authorityId: receipt.id,
          issuedAt: Math.floor(receipt.issued_at.getTime() / 1000),
          expiresAt: Math.floor(receipt.expires_at.getTime() / 1000),
          deliveryPath: photo.delivery_path,
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
  public isCurrent(input: MediaSourceAuthorityQuery): Promise<boolean> {
    return new PostgresMediaDeliveryAuthorization(this.database, this.environment).isCurrent(input);
  }
}
