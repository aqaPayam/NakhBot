import type { AuthorizedMediaDelivery, UserSessionActor } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { lockUserPair, lockUserPairAccounts } from './pair-lock.js';
import { requireCurrentUserSession } from './user-session-store.js';
import {
  PostgresMediaDeliveryAuthorization,
  type MediaSourceAuthorityQuery,
} from './media-delivery-authorization.js';

type Environment = 'development' | 'test' | 'staging' | 'production';
type Delivery = {
  id: string;
  viewer_user_id: string;
  target_user_id: string;
  state: 'reserved' | 'delivered' | 'failed';
  attempt_count: number;
};
export type CandidatePresentation =
  | Readonly<{ state: 'delivered' | 'failed' | 'pending' }>
  | Readonly<{
      state: 'ready';
      deliveryId: string;
      telegramUserId: string;
      name: string;
      age: number;
      cityLabelKey: string;
      highlight: string;
      profileVersion: number;
      authority: AuthorizedMediaDelivery;
      source: MediaSourceAuthorityQuery;
    }>;
function denied(): never {
  throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
}
/** Current presentation of one original reservation. No prose is cached in the
 * transport receipt, and the source verifier also fences deleted/returned lives. */
export class PostgresCandidatePresentationStore {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: Environment,
    owner: UserSessionActor,
  ) {
    this.owner = Object.freeze({ ...owner });
  }
  private async lock(tx: NakhDatabase, id: string): Promise<Delivery> {
    const snapshot = await tx
      .selectFrom('discovery.candidate_deliveries')
      .select(['viewer_user_id', 'target_user_id'])
      .where('id', '=', id)
      .where('viewer_user_id', '=', this.owner.userId)
      .executeTakeFirst();
    if (snapshot === undefined) denied();
    const pair = await lockUserPair(tx, snapshot.viewer_user_id, snapshot.target_user_id);
    await lockUserPairAccounts(tx, pair);
    await requireCurrentUserSession(tx, this.owner.userId, this.owner);
    const delivery = await tx
      .selectFrom('discovery.candidate_deliveries')
      .select(['id', 'viewer_user_id', 'target_user_id', 'state', 'attempt_count'])
      .where('id', '=', id)
      .where('viewer_user_id', '=', this.owner.userId)
      .forUpdate()
      .executeTakeFirst();
    if (delivery === undefined) denied();
    return delivery;
  }
  public async load(deliveryId: string): Promise<CandidatePresentation> {
    const result = await this.database.transaction().execute(async (tx) => {
      const delivery = await this.lock(tx, deliveryId);
      if (delivery.state !== 'reserved') return { state: delivery.state } as const;
      if (delivery.attempt_count !== 0) return { state: 'pending' } as const;
      const photo = await tx
        .selectFrom('profile.profiles as profile')
        .innerJoin('media.profile_photos as photo', 'photo.profile_id', 'profile.id')
        .select('photo.id')
        .where('profile.user_id', '=', delivery.target_user_id)
        .where('photo.status', '=', 'visible')
        .where('photo.is_primary', '=', true)
        .where('photo.deleted_at', 'is', null)
        .executeTakeFirst();
      if (photo === undefined) denied();
      return { state: 'photo', photoId: photo.id } as const;
    });
    if (result.state !== 'photo') return result;
    const authorization = new PostgresMediaDeliveryAuthorization(this.database, this.environment, {
      deliveryId,
      session: this.owner,
    });
    const authority = await authorization.authorize({
      actor: { kind: 'user', userId: this.owner.userId },
      photoId: result.photoId,
      purpose: 'profile_card',
      requestedVariant: 'thumbnail',
    });
    const source: MediaSourceAuthorityQuery = {
      authorityId: authority.authorityId,
      audienceId: this.owner.userId,
      path: authority.deliveryPath,
      purpose: 'profile_card',
      variant: 'thumbnail',
      issuedAt: authority.issuedAt,
      expiresAt: authority.expiresAt,
    };
    return this.database.transaction().execute(async (tx) => {
      const delivery = await this.lock(tx, deliveryId);
      if (delivery.state !== 'reserved') return { state: delivery.state };
      if (delivery.attempt_count !== 0) return { state: 'pending' };
      if (!(await new PostgresMediaDeliveryAuthorization(tx, this.environment).isCurrent(source)))
        denied();
      const card = await tx
        .selectFrom('profile.profiles as profile')
        .innerJoin('catalog.cities as city', 'city.id', 'profile.city_id')
        .innerJoin('identity.telegram_identities as telegram', (join) =>
          join.on('telegram.user_id', '=', this.owner.userId),
        )
        .select([
          'profile.name',
          'profile.highlight',
          'profile.version as profileVersion',
          'city.label_key as cityLabelKey',
          'telegram.telegram_user_id as telegramUserId',
          sql<number>`EXTRACT(YEAR FROM timezone('UTC',clock_timestamp()))::integer-profile.birth_year`.as(
            'age',
          ),
        ])
        .where('profile.user_id', '=', delivery.target_user_id)
        .executeTakeFirst();
      if (card === undefined) denied();
      return { state: 'ready', deliveryId, ...card, authority, source };
    });
  }
  /** Exactly one provider invocation may start. Ambiguous starts remain pending;
   * neither expiry nor another callback constitutes proof of non-delivery. */
  public begin(
    deliveryId: string,
    input: MediaSourceAuthorityQuery,
    profileVersion: number,
  ): Promise<boolean> {
    const source = structuredClone(input);
    return this.database.transaction().execute(async (tx) => {
      const delivery = await this.lock(tx, deliveryId);
      if (delivery.state !== 'reserved' || delivery.attempt_count !== 0) return false;
      if (
        source.audienceId !== this.owner.userId ||
        source.purpose !== 'profile_card' ||
        source.variant !== 'thumbnail'
      )
        denied();
      if (!Number.isSafeInteger(profileVersion) || profileVersion < 1) denied();
      const profile = await tx
        .selectFrom('profile.profiles')
        .select('version')
        .where('user_id', '=', delivery.target_user_id)
        .executeTakeFirst();
      if (profile?.version !== profileVersion) return false;
      const receipt = await tx
        .selectFrom('media.delivery_grants')
        .select('id')
        .where('id', '=', source.authorityId)
        .where('candidate_delivery_id', '=', deliveryId)
        .where('session_grant_id', '=', this.owner.sessionGrantId)
        .executeTakeFirst();
      if (
        receipt === undefined ||
        !(await new PostgresMediaDeliveryAuthorization(tx, this.environment).isCurrent(source))
      )
        denied();
      const changed = await tx
        .updateTable('discovery.candidate_deliveries')
        .set({ attempt_count: 1, updated_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', deliveryId)
        .where('state', '=', 'reserved')
        .where('attempt_count', '=', 0)
        .executeTakeFirst();
      return changed.numUpdatedRows === 1n;
    });
  }
}
