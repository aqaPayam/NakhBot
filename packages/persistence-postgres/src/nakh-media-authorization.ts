import { randomUUID } from 'node:crypto';
import type {
  AuthorizedMediaDelivery,
  MediaDeliveryAuthorizationPort,
  UserSessionActor,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { requireNakhProfileSource } from './nakh-profile-source.js';
import {
  PostgresMediaDeliveryAuthorization,
  type MediaSourceAuthorityQuery,
} from './media-delivery-authorization.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function denied(): never {
  throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
}
/** A received Nakh is its own source; it is never a fabricated candidate or
 * borrowed Like unlock. The native receipt guard repeats admission after waits. */
export class PostgresNakhMediaAuthorization implements MediaDeliveryAuthorizationPort {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    owner: UserSessionActor,
    private readonly nakhId: string,
  ) {
    this.owner = Object.freeze({ ...owner });
    if (!UUID.test(nakhId)) denied();
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
      input.purpose !== 'profile_detail' ||
      input.requestedVariant !== 'thumbnail' ||
      !Number.isSafeInteger(ttl) ||
      ttl < 10 ||
      ttl > 300
    )
      denied();
    try {
      return await this.database.transaction().execute(async (tx) => {
        const scope = await requireNakhProfileSource(tx, this.owner, this.nakhId);
        const photo = await tx
          .selectFrom('media.profile_photos as p')
          .innerJoin('profile.profiles as owner', 'owner.id', 'p.profile_id')
          .innerJoin('media.photo_variants as v', 'v.asset_id', 'p.asset_id')
          .select(['p.id', 'p.asset_id', 'v.id as variantId', 'v.delivery_path'])
          .where('p.id', '=', input.photoId)
          .where('owner.user_id', '=', scope.targetId)
          .where('p.status', '=', 'visible')
          .where('p.deleted_at', 'is', null)
          .where('v.variant_type', '=', 'thumbnail')
          .where('v.transformation_version', '=', 1)
          .where('v.deleted_at', 'is', null)
          .where('v.storage_deleted_at', 'is', null)
          .executeTakeFirst();
        if (!photo) denied();
        const target = await tx
          .selectFrom('identity.accounts')
          .select('product_epoch')
          .where('user_id', '=', scope.targetId)
          .executeTakeFirst();
        if (!target) denied();
        const receipt = await tx
          .insertInto('media.delivery_grants')
          .values({
            id: randomUUID(),
            actor_user_id: this.owner.userId,
            owner_user_id: scope.targetId,
            actor_product_epoch: this.owner.productEpoch,
            owner_product_epoch: target.product_epoch,
            photo_id: photo.id,
            asset_id: photo.asset_id,
            variant_id: photo.variantId,
            like_id: null,
            candidate_delivery_id: null,
            feature_unlock_id: null,
            nakh_id: this.nakhId,
            session_grant_id: this.owner.sessionGrantId,
            purpose: 'profile_detail',
            variant_type: 'thumbnail',
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
          variantType: 'thumbnail',
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
