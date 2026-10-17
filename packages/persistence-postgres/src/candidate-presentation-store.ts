import type { AuthorizedMediaDelivery, UserSessionActor } from '@nakh/application';
import { ApplicationError, PROFILE_LIMITS } from '@nakh/domain';
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
export type CandidateProfileDetail = Readonly<{
  telegramUserId: string;
  name: string;
  age: number;
  profileVersion: number;
  locationLabelKeys: readonly string[];
  genderLabelKey: string;
  preferenceLabelKey: string;
  goalLabelKey: string;
  interestLabelKeys: readonly string[];
  highlight: string;
  bio: string;
  optional: readonly Readonly<{ labelKey: string; value: string | number | readonly string[] }>[];
  photos: readonly Readonly<{
    authority: AuthorizedMediaDelivery;
    source: MediaSourceAuthorityQuery;
  }>[];
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
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id))
      denied();
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
  private async detailPhotos(tx: NakhDatabase, targetId: string): Promise<string[]> {
    const rows = await tx
      .selectFrom('profile.profiles as profile')
      .innerJoin('media.profile_photos as photo', 'photo.profile_id', 'profile.id')
      .select('photo.id')
      .where('profile.user_id', '=', targetId)
      .where('photo.status', '=', 'visible')
      .where('photo.deleted_at', 'is', null)
      .orderBy('photo.is_primary', 'desc')
      .orderBy('photo.display_order')
      .orderBy('photo.id')
      .limit(PROFILE_LIMITS.maximumPhotos + 1)
      .execute();
    if (rows.length === 0 || rows.length > PROFILE_LIMITS.maximumPhotos) denied();
    return rows.map((r) => r.id);
  }
  private async detailSourcesCurrent(
    tx: NakhDatabase,
    delivery: Delivery,
    sources: readonly MediaSourceAuthorityQuery[],
  ): Promise<boolean> {
    if (
      delivery.state !== 'delivered' ||
      sources.length < 1 ||
      sources.length > PROFILE_LIMITS.maximumPhotos ||
      new Set(sources.map((s) => s.authorityId)).size !== sources.length
    )
      return false;
    const grants = await tx
      .selectFrom('media.delivery_grants')
      .select(['id', 'photo_id'])
      .where(
        'id',
        'in',
        sources.map((s) => s.authorityId),
      )
      .where('candidate_delivery_id', '=', delivery.id)
      .where('session_grant_id', '=', this.owner.sessionGrantId)
      .execute();
    if (grants.length !== sources.length) return false;
    const photos = await this.detailPhotos(tx, delivery.target_user_id);
    if (
      photos.length !== grants.length ||
      photos.some((id) => !grants.some((g) => g.photo_id === id))
    )
      return false;
    const verifier = new PostgresMediaDeliveryAuthorization(tx, this.environment);
    for (const source of sources)
      if (
        source.purpose !== 'profile_detail' ||
        source.variant !== 'thumbnail' ||
        source.audienceId !== this.owner.userId ||
        !(await verifier.isCurrent(source))
      )
        return false;
    return true;
  }
  /** A delivered card selects the original target. Reads never reserve/consume another preview. */
  public async detail(deliveryId: string): Promise<CandidateProfileDetail> {
    const photoIds = await this.database.transaction().execute(async (tx) => {
      const delivery = await this.lock(tx, deliveryId);
      if (delivery.state !== 'delivered') denied();
      return this.detailPhotos(tx, delivery.target_user_id);
    });
    const authorization = new PostgresMediaDeliveryAuthorization(this.database, this.environment, {
      deliveryId,
      session: this.owner,
    });
    const photos: Array<CandidateProfileDetail['photos'][number]> = [];
    for (const photoId of photoIds) {
      const authority = await authorization.authorize({
        actor: { kind: 'user', userId: this.owner.userId },
        photoId,
        purpose: 'profile_detail',
        requestedVariant: 'thumbnail',
      });
      photos.push({
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
      const delivery = await this.lock(tx, deliveryId);
      if (
        !(await this.detailSourcesCurrent(
          tx,
          delivery,
          photos.map((p) => p.source),
        ))
      )
        denied();
      const profile = await tx
        .selectFrom('profile.profiles as p')
        .innerJoin('catalog.cities as city', 'city.id', 'p.city_id')
        .innerJoin('catalog.provinces as province', 'province.id', 'p.province_id')
        .innerJoin('catalog.countries as country', 'country.id', 'p.country_id')
        .innerJoin('catalog.gender_options as gender', 'gender.id', 'p.gender_option_id')
        .innerJoin(
          'catalog.gender_preferences as preference',
          'preference.id',
          'p.gender_preference_id',
        )
        .innerJoin('catalog.relationship_goals as goal', 'goal.id', 'p.relationship_goal_id')
        .innerJoin('identity.telegram_identities as telegram', (join) =>
          join.on('telegram.user_id', '=', this.owner.userId),
        )
        .select([
          'p.id',
          'p.name',
          'p.highlight',
          'p.bio',
          'p.version as profileVersion',
          'city.label_key as city',
          'province.label_key as province',
          'country.label_key as country',
          'gender.label_key as genderLabelKey',
          'preference.label_key as preferenceLabelKey',
          'goal.label_key as goalLabelKey',
          'telegram.telegram_user_id as telegramUserId',
          sql<number>`EXTRACT(YEAR FROM timezone('UTC',clock_timestamp()))::integer-p.birth_year`.as(
            'age',
          ),
        ])
        .where('p.user_id', '=', delivery.target_user_id)
        .executeTakeFirst();
      if (!profile) denied();
      const interests = await tx
        .selectFrom('profile.profile_interests as s')
        .innerJoin('catalog.interests as c', 'c.id', 's.interest_id')
        .select('c.label_key')
        .where('s.profile_id', '=', profile.id)
        .where('c.is_active', '=', true)
        .orderBy('c.display_order')
        .orderBy('c.code')
        .execute();
      const optional: Array<CandidateProfileDetail['optional'][number]> = [];
      const details = await tx
        .selectFrom('profile.profile_optional_details')
        .selectAll()
        .where('profile_id', '=', profile.id)
        .executeTakeFirst();
      if (details) {
        if (details.height_cm !== null)
          optional.push({ labelKey: 'signup.ui.height_cm', value: details.height_cm });
        if (details.job_title !== null)
          optional.push({ labelKey: 'signup.ui.job', value: details.job_title });
        const options = await tx
          .selectFrom('catalog.profile_option_values')
          .select(['category', 'code', 'label_key'])
          .where('is_active', '=', true)
          .execute();
        for (const [field, category, label] of [
          ['education_level_code', 'education', 'education_level_code'],
          ['smoking_preference_code', 'smoking', 'smoking_preference_code'],
          ['pets_preference_code', 'pets', 'pets_preference_code'],
          ['exercise_frequency_code', 'exercise', 'exercise_frequency_code'],
          ['religion_importance_code', 'religion_importance', 'religion_code'],
          ['children_preference_code', 'children_preference', 'children_preference_code'],
        ] as const) {
          const option = options.find((o) => o.category === category && o.code === details[field]);
          if (option) optional.push({ labelKey: 'signup.ui.' + label, value: [option.label_key] });
        }
      }
      const languages = await tx
        .selectFrom('profile.profile_languages as s')
        .innerJoin('catalog.languages as c', 'c.id', 's.language_id')
        .select('c.label_key')
        .where('s.profile_id', '=', profile.id)
        .where('c.is_active', '=', true)
        .orderBy('c.display_order')
        .orderBy('c.code')
        .execute();
      const tags = await tx
        .selectFrom('profile.profile_personality_tags as s')
        .innerJoin('catalog.personality_tags as c', 'c.id', 's.personality_tag_id')
        .select('c.label_key')
        .where('s.profile_id', '=', profile.id)
        .where('c.is_active', '=', true)
        .orderBy('c.display_order')
        .orderBy('c.code')
        .execute();
      if (languages.length)
        optional.push({
          labelKey: 'signup.ui.language_codes',
          value: languages.map((r) => r.label_key),
        });
      if (tags.length)
        optional.push({
          labelKey: 'signup.ui.personality_tag_codes',
          value: tags.map((r) => r.label_key),
        });
      return {
        telegramUserId: profile.telegramUserId,
        name: profile.name,
        age: profile.age,
        profileVersion: profile.profileVersion,
        locationLabelKeys: [profile.city, profile.province, profile.country],
        genderLabelKey: profile.genderLabelKey,
        preferenceLabelKey: profile.preferenceLabelKey,
        goalLabelKey: profile.goalLabelKey,
        interestLabelKeys: interests.map((r) => r.label_key),
        highlight: profile.highlight,
        bio: profile.bio ?? '',
        optional,
        photos,
      };
    });
  }
  /** Recheck every current source and the text version immediately before each provider send. */
  public detailIsCurrent(
    deliveryId: string,
    input: Pick<CandidateProfileDetail, 'profileVersion' | 'photos'>,
  ): Promise<boolean> {
    const captured = structuredClone(input);
    return this.database.transaction().execute(async (tx) => {
      const delivery = await this.lock(tx, deliveryId);
      if (
        !(await this.detailSourcesCurrent(
          tx,
          delivery,
          captured.photos.map((p) => p.source),
        ))
      )
        return false;
      const profile = await tx
        .selectFrom('profile.profiles')
        .select('version')
        .where('user_id', '=', delivery.target_user_id)
        .executeTakeFirst();
      return profile?.version === captured.profileVersion;
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
