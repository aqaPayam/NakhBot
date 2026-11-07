import type { UserSessionActor } from '@nakh/application';
import { ApplicationError, PROFILE_LIMITS } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import type { CandidateProfileDetail } from './candidate-presentation-store.js';
import { PostgresNakhMediaAuthorization } from './nakh-media-authorization.js';
import { PostgresMediaDeliveryAuthorization } from './media-delivery-authorization.js';
import { readProfileDetailProjection } from './profile-detail-projection.js';
import { requireNakhProfileSource } from './nakh-profile-source.js';

function denied(): never {
  throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 403);
}
/** Full profiles are transient projections of one original received, viewed Nakh. */
export class PostgresNakhProfileStore {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    owner: UserSessionActor,
    private readonly deliveryTtlSeconds = 60,
  ) {
    this.owner = Object.freeze({ ...owner });
  }
  private lock(tx: NakhDatabase, nakhId: string): Promise<{ targetId: string; flowId: string }> {
    return requireNakhProfileSource(tx, this.owner, nakhId);
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
    nakhId: string,
    scope: { targetId: string; flowId: string },
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
        .where('nakh_id', '=', nakhId)
        .where('session_grant_id', '=', this.owner.sessionGrantId)
        .where('photo_id', '=', photo.photoId)
        .executeTakeFirst();
      if (!grant || !(await verifier.isCurrent(photo.source))) return false;
    }
    return true;
  }
  public async detail(nakhId: string): Promise<CandidateProfileDetail> {
    const initial = await this.database.transaction().execute(async (tx) => {
      const scope = await this.lock(tx, nakhId);
      return { ...scope, photoIds: await this.photoIds(tx, scope.targetId) };
    });
    const authorization = new PostgresNakhMediaAuthorization(
      this.database,
      this.environment,
      this.owner,
      nakhId,
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
      const scope = await this.lock(tx, nakhId);
      if (!(await this.sourcesCurrent(tx, nakhId, scope, photos))) denied();
      return readProfileDetailProjection(tx, this.owner.userId, scope.targetId, photos);
    });
  }
  public async detailIsCurrent(
    nakhId: string,
    input: Pick<CandidateProfileDetail, 'profileVersion' | 'photos'>,
  ): Promise<boolean> {
    const captured = structuredClone(input);
    return this.database.transaction().execute(async (tx) => {
      const scope = await this.lock(tx, nakhId);
      if (!(await this.sourcesCurrent(tx, nakhId, scope, captured.photos))) return false;
      const profile = await tx
        .selectFrom('profile.profiles')
        .select('version')
        .where('user_id', '=', scope.targetId)
        .executeTakeFirst();
      return profile?.version === captured.profileVersion;
    });
  }
}
