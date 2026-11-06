import { sql } from 'kysely';
import type { UserSessionActor } from '@nakh/application';
import { ApplicationError, PROFILE_LIMITS } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import type { CandidateProfileDetail } from './candidate-presentation-store.js';
import { PostgresLikedByMediaAuthorization } from './liked-by-media-authorization.js';
import { PostgresMediaDeliveryAuthorization } from './media-delivery-authorization.js';
import { lockAndValidatePaidActionTarget } from './paid-action-store.js';
import { readProfileDetailProjection } from './profile-detail-projection.js';
import { requireCurrentUserSession } from './user-session-store.js';

function denied(): never {
  throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 403);
}
/** Full profiles are transient projections of one original owned unlock. */
export class PostgresLikedByProfileStore {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    owner: UserSessionActor,
    private readonly deliveryTtlSeconds = 60,
  ) {
    this.owner = Object.freeze({ ...owner });
  }
  private async lock(
    tx: NakhDatabase,
    unlockId: string,
  ): Promise<{ likeId: string; targetId: string }> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(unlockId)
    )
      denied();
    const scope = await tx
      .selectFrom('interaction.feature_unlocks as u')
      .innerJoin('interaction.likes as l', 'l.id', 'u.like_id')
      .select(['l.id as likeId', 'l.sender_user_id as targetId'])
      .where('u.id', '=', unlockId)
      .where('u.payer_user_id', '=', this.owner.userId)
      .where('u.feature_type', '=', 'liked_by_profile_unlock')
      .executeTakeFirst();
    if (!scope) denied();
    await lockAndValidatePaidActionTarget(tx, this.owner.userId, {
      type: 'like',
      targetId: scope.likeId,
    });
    await requireCurrentUserSession(tx, this.owner.userId, this.owner);
    const current = await tx
      .selectFrom('interaction.feature_unlocks as u')
      .select('u.id')
      .where('u.id', '=', unlockId)
      .where('u.payer_user_id', '=', this.owner.userId)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM interaction.feature_unlock_reference_anchors a
        WHERE a.id=u.id AND a.payer_user_id=${this.owner.userId}::uuid
        AND a.payer_product_epoch=${this.owner.productEpoch})`,
      )
      .where('u.status', '=', 'active')
      .where('u.revoked_at', 'is', null)
      .where('u.expired_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('u.expires_at', 'is', null),
          eb('u.expires_at', '>', sql<Date>`clock_timestamp()`),
        ]),
      )
      .executeTakeFirst();
    if (!current) denied();
    return scope;
  }
  private async photoIds(tx: NakhDatabase, targetId: string): Promise<string[]> {
    const rows = await tx
      .selectFrom('media.profile_photos as p')
      .innerJoin('profile.profiles as owner', 'owner.id', 'p.profile_id')
      .select('p.id')
      .where('owner.user_id', '=', targetId)
      .where('p.status', '=', 'visible')
      .where('p.deleted_at', 'is', null)
      .orderBy('p.is_primary', 'desc')
      .orderBy('p.display_order')
      .orderBy('p.id')
      .limit(PROFILE_LIMITS.maximumPhotos + 1)
      .execute();
    if (!rows.length || rows.length > PROFILE_LIMITS.maximumPhotos) denied();
    return rows.map((r) => r.id);
  }
  private async sourcesCurrent(
    tx: NakhDatabase,
    unlockId: string,
    scope: { likeId: string; targetId: string },
    photos: CandidateProfileDetail['photos'],
  ): Promise<boolean> {
    const ids = await this.photoIds(tx, scope.targetId);
    if (
      photos.length !== ids.length ||
      new Set(photos.map((p) => p.photoId)).size !== ids.length ||
      new Set(photos.map((p) => p.source.authorityId)).size !== ids.length
    )
      return false;
    const verifier = new PostgresMediaDeliveryAuthorization(tx, this.environment);
    for (const photo of photos) {
      if (
        !ids.includes(photo.photoId) ||
        photo.source.audienceId !== this.owner.userId ||
        photo.source.purpose !== 'profile_detail' ||
        photo.source.variant !== 'thumbnail'
      )
        return false;
      const grant = await tx
        .selectFrom('media.delivery_grants')
        .select('id')
        .where('id', '=', photo.source.authorityId)
        .where('feature_unlock_id', '=', unlockId)
        .where('like_id', '=', scope.likeId)
        .where('session_grant_id', '=', this.owner.sessionGrantId)
        .where('photo_id', '=', photo.photoId)
        .executeTakeFirst();
      if (!grant || !(await verifier.isCurrent(photo.source))) return false;
    }
    return true;
  }
  public async detail(unlockId: string): Promise<CandidateProfileDetail> {
    const initial = await this.database.transaction().execute(async (tx) => {
      const scope = await this.lock(tx, unlockId);
      return { ...scope, photoIds: await this.photoIds(tx, scope.targetId) };
    });
    const authorization = new PostgresLikedByMediaAuthorization(
      this.database,
      this.environment,
      this.owner,
      initial.likeId,
      unlockId,
    );
    const photos: Array<CandidateProfileDetail['photos'][number]> = [];
    for (const photoId of initial.photoIds) {
      const authority = await authorization.authorize({
        actor: { kind: 'user', userId: this.owner.userId },
        photoId,
        purpose: 'profile_detail',
        requestedVariant: 'thumbnail',
        ttlSeconds: this.deliveryTtlSeconds,
      });
      photos.push({
        photoId,
        authority,
        source: {
          authorityId: authority.authorityId,
          audienceId: this.owner.userId,
          path: authority.deliveryPath,
          purpose: 'profile_detail',
          variant: 'thumbnail',
          issuedAt: authority.issuedAt,
          expiresAt: authority.expiresAt,
        },
      });
    }
    return this.database.transaction().execute(async (tx) => {
      const scope = await this.lock(tx, unlockId);
      if (!(await this.sourcesCurrent(tx, unlockId, scope, photos))) denied();
      return readProfileDetailProjection(tx, this.owner.userId, scope.targetId, photos);
    });
  }
  public async detailIsCurrent(
    unlockId: string,
    input: Pick<CandidateProfileDetail, 'profileVersion' | 'photos'>,
  ): Promise<boolean> {
    const captured = structuredClone(input);
    return this.database.transaction().execute(async (tx) => {
      const scope = await this.lock(tx, unlockId);
      if (!(await this.sourcesCurrent(tx, unlockId, scope, captured.photos))) return false;
      const profile = await tx
        .selectFrom('profile.profiles')
        .select('version')
        .where('user_id', '=', scope.targetId)
        .executeTakeFirst();
      return profile?.version === captured.profileVersion;
    });
  }
}
