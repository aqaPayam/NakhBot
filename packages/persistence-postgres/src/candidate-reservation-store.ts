import { createHash } from 'node:crypto';

import { sql, type RawBuilder } from 'kysely';

import type { CandidateReservation, CandidateReservationStore } from '@nakh/application';
import type { GetNextExploreCandidateQuery } from '@nakh/contracts';
import { ApplicationError, evaluateCapability, shuffleCandidates } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

type Generated = Readonly<{ deliveryId: string; eventId: string; reservedAt: Date }>;

type ViewerFacts = Readonly<{
  accountState: 'guest' | 'incomplete' | 'active' | 'restricted' | 'banned' | 'deleted';
  visibilityEnabled: boolean;
  profileId: string | null;
  completionStatus: 'incomplete' | 'complete' | 'invalid' | null;
  genderOptionId: string | null;
  genderPreferenceId: string | null;
  birthYear: number | null;
  cityId: string | null;
  filterMinAge: number | null;
  filterMaxAge: number | null;
  filterCityId: string | null;
  filterRelationshipGoalId: string | null;
  filterVersion: number | null;
  currentYear: number;
}>;

type EffectiveFilter = Readonly<{
  genderOptionIds: readonly string[];
  minAge: number;
  maxAge: number;
  cityId: string;
  relationshipGoalId: string | null;
  version: number;
}>;

const reservationLifetimeMs = 5 * 60 * 1000;

function requestSeed(requestId: string): number {
  return createHash('sha256').update(requestId).digest().readUInt32BE(0);
}

function unavailable(message = 'error.discovery.unavailable'): never {
  throw new ApplicationError('discovery_unavailable', message, 403);
}

async function lockViewer(database: NakhDatabase, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`candidate:${userId}`}, 0))`.execute(
    database,
  );
}

async function loadViewer(database: NakhDatabase, userId: string): Promise<ViewerFacts> {
  const viewer = await database
    .selectFrom('identity.users as user')
    .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
    .innerJoin('identity.user_settings as settings', 'settings.user_id', 'user.id')
    .leftJoin('profile.profiles as profile', 'profile.user_id', 'user.id')
    .leftJoin('discovery.explore_filters as filter', 'filter.user_id', 'user.id')
    .select([
      'account.state as accountState',
      'settings.visibility_enabled as visibilityEnabled',
      'profile.id as profileId',
      'profile.completion_status as completionStatus',
      'profile.gender_option_id as genderOptionId',
      'profile.gender_preference_id as genderPreferenceId',
      'profile.birth_year as birthYear',
      'profile.city_id as cityId',
      'filter.min_age as filterMinAge',
      'filter.max_age as filterMaxAge',
      'filter.city_id as filterCityId',
      'filter.relationship_goal_id as filterRelationshipGoalId',
      'filter.version as filterVersion',
      sql<number>`EXTRACT(YEAR FROM timezone('UTC', transaction_timestamp()))::integer`.as(
        'currentYear',
      ),
    ])
    .where('user.id', '=', userId)
    .executeTakeFirst();
  if (viewer === undefined) unavailable();
  return viewer;
}

function validateViewer(viewer: ViewerFacts, mode: GetNextExploreCandidateQuery['mode']): void {
  const decision = evaluateCapability(
    {
      accountState: viewer.accountState,
      profileCompletion: viewer.completionStatus,
      visibilityEnabled: viewer.visibilityEnabled,
    },
    mode === 'explore' ? 'start_discovery' : 'guest_preview',
  );
  if (!decision.allowed) unavailable('error.capability.denied');
}

async function effectiveFilter(
  database: NakhDatabase,
  viewerId: string,
  viewer: ViewerFacts,
  requestedVersion: number | undefined,
): Promise<EffectiveFilter> {
  if (
    viewer.profileId === null ||
    viewer.genderPreferenceId === null ||
    viewer.birthYear === null ||
    viewer.cityId === null
  )
    unavailable();
  const persisted = viewer.filterVersion !== null;
  const version = viewer.filterVersion ?? 1;
  if (requestedVersion !== undefined && requestedVersion !== version)
    throw new ApplicationError('version_conflict', 'error.discovery.version_conflict', 409);
  const genderRows = persisted
    ? await database
        .selectFrom('discovery.explore_filter_genders')
        .select('gender_option_id')
        .where('user_id', '=', viewerId)
        .orderBy('gender_option_id')
        .execute()
    : await database
        .selectFrom('catalog.gender_preference_members as member')
        .innerJoin('catalog.gender_options as gender', 'gender.id', 'member.gender_option_id')
        .select('member.gender_option_id')
        .where('member.gender_preference_id', '=', viewer.genderPreferenceId)
        .where('gender.is_active', '=', true)
        .orderBy('member.gender_option_id')
        .execute();
  if (genderRows.length === 0) unavailable();
  const age = viewer.currentYear - viewer.birthYear;
  return {
    genderOptionIds: genderRows.map((row) => row.gender_option_id),
    minAge: viewer.filterMinAge ?? Math.max(18, age - 5),
    maxAge: viewer.filterMaxAge ?? Math.min(120, age + 5),
    cityId: viewer.filterCityId ?? viewer.cityId,
    relationshipGoalId: viewer.filterRelationshipGoalId,
    version,
  };
}

async function assertGuestCapacity(database: NakhDatabase, viewerId: string): Promise<void> {
  const counter = await database
    .selectFrom('identity.guest_preview_counters')
    .select(['preview_count', 'limit_count'])
    .where('user_id', '=', viewerId)
    .forUpdate()
    .executeTakeFirst();
  if (counter === undefined) unavailable();
  const live = await database
    .selectFrom('discovery.candidate_deliveries')
    .select((expression) => expression.fn.countAll<number>().as('count'))
    .where('viewer_user_id', '=', viewerId)
    .where('mode', '=', 'guest_preview')
    .where('state', '=', 'reserved')
    .executeTakeFirstOrThrow();
  if (counter.preview_count + Number(live.count) >= counter.limit_count)
    throw new ApplicationError(
      'guest_preview_limit_reached',
      'error.guest_preview.limit_reached',
      409,
    );
}

function pairExclusion(
  mode: GetNextExploreCandidateQuery['mode'],
  viewerId: string,
): RawBuilder<unknown> {
  return mode === 'explore'
    ? sql`NOT EXISTS (
        SELECT 1 FROM interaction.user_pair_states pair
        WHERE pair.user_low_id = LEAST(target.user_id, ${viewerId}::uuid)
          AND pair.user_high_id = GREATEST(target.user_id, ${viewerId}::uuid)
      )`
    : sql`NOT EXISTS (
        SELECT 1 FROM interaction.user_pair_states pair
        WHERE pair.user_low_id = LEAST(target.user_id, ${viewerId}::uuid)
          AND pair.user_high_id = GREATEST(target.user_id, ${viewerId}::uuid)
          AND pair.state = 'blocked'
      )`;
}

function candidatePoolStatement(
  query: GetNextExploreCandidateQuery,
  viewer: ViewerFacts,
  filter: EffectiveFilter | undefined,
  exactTargetId?: string,
): RawBuilder<{ target_user_id: string }> {
  const viewerId = query.actor.userId;
  const explore = query.mode === 'explore';
  if (explore && (filter === undefined || viewer.genderOptionId === null)) unavailable();
  const modeConditions = explore
    ? sql`AND target.gender_option_id IN (${sql.join(filter!.genderOptionIds)})
        AND target.city_id = ${filter!.cityId}::uuid
        AND target.birth_year BETWEEN ${viewer.currentYear - filter!.maxAge}
          AND ${viewer.currentYear - filter!.minAge}
        AND (${filter!.relationshipGoalId}::uuid IS NULL
          OR target.relationship_goal_id = ${filter!.relationshipGoalId}::uuid)
        AND EXISTS (
          SELECT 1 FROM catalog.gender_preference_members viewer_preference
          WHERE viewer_preference.gender_preference_id = ${viewer.genderPreferenceId}::uuid
            AND viewer_preference.gender_option_id = target.gender_option_id
        )
        AND EXISTS (
          SELECT 1 FROM catalog.gender_preference_members target_preference
          WHERE target_preference.gender_preference_id = target.gender_preference_id
            AND target_preference.gender_option_id = ${viewer.genderOptionId}::uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM interaction.not_interested rejection
          WHERE (rejection.sender_user_id = ${viewerId}::uuid
              AND rejection.receiver_user_id = target.user_id)
             OR (rejection.sender_user_id = target.user_id
              AND rejection.receiver_user_id = ${viewerId}::uuid)
        )`
    : sql``;
  const exactTarget =
    exactTargetId === undefined ? sql`` : sql`AND target.user_id = ${exactTargetId}`;
  return sql<{ target_user_id: string }>`
    SELECT target.user_id AS target_user_id
    FROM profile.profiles target
    JOIN identity.accounts target_account ON target_account.user_id = target.user_id
    JOIN identity.user_settings target_settings ON target_settings.user_id = target.user_id
    JOIN catalog.countries country ON country.id = target.country_id
    JOIN catalog.cities city ON city.id = target.city_id
    JOIN catalog.gender_options target_gender ON target_gender.id = target.gender_option_id
    JOIN catalog.gender_preferences target_preference
      ON target_preference.id = target.gender_preference_id
    JOIN catalog.relationship_goals target_goal ON target_goal.id = target.relationship_goal_id
    WHERE target.user_id <> ${viewerId}::uuid
      AND target_account.state = 'active'
      AND target.completion_status = 'complete'
      AND target_settings.visibility_enabled
      AND country.code = 'iran' AND country.is_active
      AND city.is_active
      AND target_gender.is_active AND target_preference.is_active AND target_goal.is_active
      AND EXISTS (
        SELECT 1
        FROM media.profile_photos photo
        JOIN media.media_assets asset ON asset.id = photo.asset_id
        JOIN media.photo_variants variant ON variant.asset_id = asset.id
        WHERE photo.profile_id = target.id
          AND photo.status = 'visible' AND photo.is_primary
          AND asset.validation_state = 'valid'
          AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL
          AND variant.variant_type = 'thumbnail' AND variant.transformation_version = 1
          AND variant.deleted_at IS NULL AND variant.storage_deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM discovery.explore_consumptions consumption
        WHERE consumption.viewer_user_id = ${viewerId}::uuid
          AND consumption.target_user_id = target.user_id
      )
      AND ${pairExclusion(query.mode, viewerId)}
      ${modeConditions}
      ${exactTarget}
    ORDER BY target.random_shuffle_key, target.id
    LIMIT 100
  `;
}

async function candidatePool(
  database: NakhDatabase,
  query: GetNextExploreCandidateQuery,
  viewer: ViewerFacts,
  filter: EffectiveFilter | undefined,
  exactTargetId?: string,
): Promise<readonly string[]> {
  const result = await candidatePoolStatement(query, viewer, filter, exactTargetId).execute(
    database,
  );
  return result.rows.map((row) => row.target_user_id);
}

/** Runs the exact bounded candidate-pool statement under PostgreSQL plan instrumentation. */
export async function explainCandidatePool(
  database: NakhDatabase,
  query: GetNextExploreCandidateQuery,
): Promise<unknown> {
  if (query.actor.kind !== 'user')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
  const viewer = await loadViewer(database, query.actor.userId);
  validateViewer(viewer, query.mode);
  const filter =
    query.mode === 'explore'
      ? await effectiveFilter(database, query.actor.userId, viewer, query.filterVersion)
      : undefined;
  const result = await sql<{ 'QUERY PLAN': unknown }>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    ${candidatePoolStatement(query, viewer, filter)}
  `.execute(database);
  return result.rows[0]?.['QUERY PLAN'];
}

/** Refreshes only the planner statistics used by the M3 production-shaped CI gate. */
export async function analyzeM3QueryTables(database: NakhDatabase): Promise<void> {
  await sql`
    ANALYZE catalog.countries, catalog.cities, catalog.gender_options,
      catalog.gender_preferences, catalog.gender_preference_members,
      catalog.relationship_goals,
      identity.accounts, identity.user_settings, profile.profiles,
      media.media_assets, media.profile_photos, media.photo_variants,
      interaction.likes, interaction.not_interested, interaction.user_pair_states,
      discovery.explore_consumptions
  `.execute(database);
}

export class PostgresCandidateReservationStore implements CandidateReservationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public reserveNext(
    query: GetNextExploreCandidateQuery,
    generated: Generated,
  ): Promise<CandidateReservation | undefined> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.database.transaction().execute(async (transaction) => {
      const viewerId = query.actor.userId;
      await lockViewer(transaction, viewerId);
      let viewer = await loadViewer(transaction, viewerId);
      validateViewer(viewer, query.mode);
      const existing = await transaction
        .selectFrom('discovery.candidate_deliveries')
        .select(['id', 'target_user_id', 'mode', 'filter_version', 'expires_at'])
        .where('viewer_user_id', '=', viewerId)
        .where('state', '=', 'reserved')
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.mode !== query.mode)
          throw new ApplicationError('conflict', 'error.discovery.reservation_in_progress', 409);
        return {
          deliveryId: existing.id,
          targetUserId: existing.target_user_id,
          mode: existing.mode,
          filterVersion: existing.filter_version,
          expiresAt: existing.expires_at.toISOString(),
        };
      }
      if (query.mode === 'guest_preview') await assertGuestCapacity(transaction, viewerId);

      let filter =
        query.mode === 'explore'
          ? await effectiveFilter(transaction, viewerId, viewer, query.filterVersion)
          : undefined;
      const pool = await candidatePool(transaction, query, viewer, filter);
      const targetId = shuffleCandidates(pool, requestSeed(query.requestId))[0];
      if (targetId === undefined) return undefined;

      await lockUserPair(transaction, viewerId, targetId);
      const lockedUsers = await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', 'in', [viewerId, targetId])
        .orderBy('id')
        .forUpdate()
        .execute();
      if (lockedUsers.length !== 2) return undefined;
      viewer = await loadViewer(transaction, viewerId);
      validateViewer(viewer, query.mode);
      filter =
        query.mode === 'explore'
          ? await effectiveFilter(transaction, viewerId, viewer, query.filterVersion)
          : undefined;
      if ((await candidatePool(transaction, query, viewer, filter, targetId)).length !== 1)
        return undefined;

      const expiresAt = new Date(generated.reservedAt.getTime() + reservationLifetimeMs);
      const filterVersion = filter?.version ?? 1;
      await transaction
        .insertInto('discovery.candidate_deliveries')
        .values({
          id: generated.deliveryId,
          viewer_user_id: viewerId,
          target_user_id: targetId,
          mode: query.mode,
          filter_version: filterVersion,
          state: 'reserved',
          expires_at: expiresAt,
          provider_message_id: null,
          reserved_at: generated.reservedAt,
          delivered_at: null,
          failed_at: null,
          updated_at: generated.reservedAt,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: generated.eventId,
          aggregate_type: 'candidate_delivery',
          aggregate_id: generated.deliveryId,
          event_type: 'discovery.candidate-reserved.v1',
          schema_version: 1,
          payload: {
            deliveryId: generated.deliveryId,
            viewerUserId: viewerId,
            targetUserId: targetId,
            mode: query.mode,
            filterVersion,
          },
          occurred_at: generated.reservedAt,
          available_at: generated.reservedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: query.requestId,
          causation_id: query.requestId,
        })
        .execute();
      return {
        deliveryId: generated.deliveryId,
        targetUserId: targetId,
        mode: query.mode,
        filterVersion,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }
}
