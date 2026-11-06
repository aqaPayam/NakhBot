import { createHash } from 'node:crypto';

import type { ExploreFilterResult, ExploreFilterStore, UserSessionActor } from '@nakh/application';
import type { SaveExploreFilterCommand } from '@nakh/contracts';
import { ApplicationError, assertExploreFilter } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { requireCurrentUserSession } from './user-session-store.js';
import { sql } from 'kysely';

export type OwnExploreFilterSnapshot = Readonly<{
  version?: number;
  minAge: number;
  maxAge: number;
  targetGenderOptionIds: readonly string[];
  allowedGenders: readonly Readonly<{ id: string; code: string; labelKey: string }>[];
  preferenceAdjusted: boolean;
  city: Readonly<{
    id: string;
    code: string;
    labelKey: string;
    provinceCode: string;
    provinceLabelKey: string;
    countryCode: string;
    countryLabelKey: string;
  }>;
  relationshipGoalCode?: string;
}>;

type Generated = Readonly<{ auditId: string; eventId: string; processedAt: Date }>;
const hash = (command: SaveExploreFilterCommand): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: 1,
        actor: command.actor,
        data: command.data,
      }),
    )
    .digest('hex');

export class PostgresExploreFilterStore implements ExploreFilterStore {
  private readonly owner: UserSessionActor | undefined;
  public constructor(
    private readonly database: NakhDatabase,
    owner?: UserSessionActor,
  ) {
    this.owner = owner === undefined ? undefined : Object.freeze({ ...owner });
  }

  /** Only the captured native owner can read settings/defaults. Public catalog
   * selectors are presentation data; mutations recheck their current authority. */
  public getOwnFilter(userId: string): Promise<OwnExploreFilterSnapshot> {
    if (!this.owner || this.owner.userId !== userId)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const owner = this.owner;
    return this.database.transaction().execute(async (tx) => {
      await requireCurrentUserSession(tx, userId, owner);
      const profile = await tx
        .selectFrom('profile.profiles as p')
        .innerJoin('identity.accounts as a', 'a.user_id', 'p.user_id')
        .select([
          'p.gender_preference_id',
          'p.birth_year',
          'p.city_id',
          'p.completion_status',
          'a.state',
        ])
        .where('p.user_id', '=', userId)
        .executeTakeFirst();
      if (
        profile?.state !== 'active' ||
        profile.completion_status !== 'complete' ||
        profile.birth_year === null ||
        profile.city_id === null ||
        profile.gender_preference_id === null
      )
        throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
      const filter = await tx
        .selectFrom('discovery.explore_filters as f')
        .leftJoin('catalog.relationship_goals as g', 'g.id', 'f.relationship_goal_id')
        .select(['f.version', 'f.min_age', 'f.max_age', 'f.city_id', 'g.code as goal'])
        .where('f.user_id', '=', userId)
        .executeTakeFirst();
      const allowedGenders = await tx
        .selectFrom('catalog.gender_preference_members as m')
        .innerJoin('catalog.gender_options as g', 'g.id', 'm.gender_option_id')
        .select(['g.id', 'g.code', 'g.label_key as labelKey'])
        .where('m.gender_preference_id', '=', profile.gender_preference_id)
        .where('g.is_active', '=', true)
        .orderBy('g.display_order')
        .orderBy('g.id')
        .execute();
      if (!allowedGenders.length)
        throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
      const saved =
        filter === undefined
          ? undefined
          : await tx
              .selectFrom('discovery.explore_filter_genders')
              .select('gender_option_id')
              .where('user_id', '=', userId)
              .orderBy('gender_option_id')
              .execute();
      const allowedIds = allowedGenders.map((g) => g.id),
        retained = saved?.map((g) => g.gender_option_id).filter((id) => allowedIds.includes(id)),
        genderIds = retained?.length ? retained : allowedIds;
      const city = await tx
        .selectFrom('catalog.cities as c')
        .innerJoin('catalog.provinces as p', 'p.id', 'c.province_id')
        .innerJoin('catalog.countries as n', 'n.id', 'p.country_id')
        .select([
          'c.id',
          'c.code',
          'c.label_key as labelKey',
          'p.code as provinceCode',
          'p.label_key as provinceLabelKey',
          'n.code as countryCode',
          'n.label_key as countryLabelKey',
        ])
        .where('c.id', '=', filter?.city_id ?? profile.city_id)
        .executeTakeFirstOrThrow();
      const year = (
          await sql<{
            year: number;
          }>`SELECT extract(year FROM current_timestamp)::integer AS year`.execute(tx)
        ).rows[0]!.year,
        age = year - profile.birth_year;
      return {
        ...(filter === undefined ? {} : { version: filter.version }),
        minAge: filter?.min_age ?? Math.min(120, Math.max(18, age - 5)),
        maxAge: filter?.max_age ?? Math.max(18, Math.min(120, age + 5)),
        targetGenderOptionIds: [...genderIds].sort(),
        allowedGenders,
        city,
        preferenceAdjusted:
          saved !== undefined && (saved.length !== retained?.length || !retained?.length),
        ...(filter?.goal ? { relationshipGoalCode: filter.goal } : {}),
      };
    });
  }

  public saveFilter(
    input: SaveExploreFilterCommand,
    effects: Generated,
  ): Promise<ExploreFilterResult> {
    const command = structuredClone(input),
      generated = structuredClone(effects);
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.database.transaction().execute(async (tx) => {
      // Stable User/Account locks precede idempotency, including internal retries.
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', command.actor.userId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const account = await tx
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', command.actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (this.owner !== undefined)
        await requireCurrentUserSession(tx, command.actor.userId, this.owner);
      const profile = await tx
        .selectFrom('profile.profiles')
        .select(['gender_preference_id', 'completion_status'])
        .where('user_id', '=', command.actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (account.state !== 'active' || profile?.completion_status !== 'complete')
        throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
      const requestHash = hash(command);
      const claim = await tx
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: command.actor.userId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(generated.processedAt.getTime() + 86_400_000),
          created_at: generated.processedAt,
          updated_at: generated.processedAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claim === undefined) {
        const prior = await tx
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', command.actor.userId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirstOrThrow();
        if (prior.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (prior.status !== 'completed' || prior.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return { ...(prior.response_json as unknown as ExploreFilterResult), replayed: true };
      }

      const allowed = await tx
        .selectFrom('catalog.gender_preference_members as member')
        .innerJoin('catalog.gender_options as gender', 'gender.id', 'member.gender_option_id')
        .select('member.gender_option_id')
        .where('member.gender_preference_id', '=', profile.gender_preference_id)
        .where('gender.is_active', '=', true)
        .execute();
      assertExploreFilter(
        {
          targetGenderOptionIds: command.data.targetGenderOptionIds,
          minAge: command.data.minAge,
          maxAge: command.data.maxAge,
          cityId: command.data.cityId,
          ...(command.data.relationshipGoalCode === undefined
            ? {}
            : { relationshipGoalCode: command.data.relationshipGoalCode }),
        },
        allowed.map((row) => row.gender_option_id),
      );
      const city = await tx
        .selectFrom('catalog.cities as c')
        .innerJoin('catalog.provinces as p', 'p.id', 'c.province_id')
        .innerJoin('catalog.countries as n', 'n.id', 'p.country_id')
        .select('c.id')
        .where('c.id', '=', command.data.cityId)
        .where('c.is_active', '=', true)
        .where('p.is_active', '=', true)
        .where('n.is_active', '=', true)
        .executeTakeFirst();
      const goal =
        command.data.relationshipGoalCode === undefined
          ? undefined
          : await tx
              .selectFrom('catalog.relationship_goals')
              .select('id')
              .where('code', '=', command.data.relationshipGoalCode)
              .where('is_active', '=', true)
              .executeTakeFirst();
      if (
        city === undefined ||
        (command.data.relationshipGoalCode !== undefined && goal === undefined)
      )
        throw new ApplicationError('invalid_request', 'error.discovery.catalog_invalid', 400);
      const current = await tx
        .selectFrom('discovery.explore_filters')
        .select('version')
        .where('user_id', '=', command.actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        (current === undefined) !== (command.data.expectedVersion === undefined) ||
        (current !== undefined && current.version !== command.data.expectedVersion)
      )
        throw new ApplicationError('version_conflict', 'error.discovery.version_conflict', 409);
      const version = current === undefined ? 1 : current.version + 1;
      const values = {
        min_age: command.data.minAge,
        max_age: command.data.maxAge,
        city_id: command.data.cityId,
        relationship_goal_id: goal?.id ?? null,
        version,
        updated_at: generated.processedAt,
      };
      if (current === undefined)
        await tx
          .insertInto('discovery.explore_filters')
          .values({ ...values, user_id: command.actor.userId, created_at: generated.processedAt })
          .execute();
      else {
        await tx
          .updateTable('discovery.explore_filters')
          .set(values)
          .where('user_id', '=', command.actor.userId)
          .execute();
        await tx
          .deleteFrom('discovery.explore_filter_genders')
          .where('user_id', '=', command.actor.userId)
          .execute();
      }
      const genderIds = [...command.data.targetGenderOptionIds].sort();
      await tx
        .insertInto('discovery.explore_filter_genders')
        .values(genderIds.map((id) => ({ user_id: command.actor.userId, gender_option_id: id })))
        .execute();
      const result: ExploreFilterResult = {
        version,
        targetGenderOptionIds: genderIds,
        minAge: command.data.minAge,
        maxAge: command.data.maxAge,
        cityId: command.data.cityId,
        ...(command.data.relationshipGoalCode === undefined
          ? {}
          : { relationshipGoalCode: command.data.relationshipGoalCode }),
        replayed: false,
      };
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: generated.auditId,
          category: 'product',
          event_type: 'discovery.filter-saved.v1',
          actor_type: 'user',
          actor_user_id: command.actor.userId,
          actor_admin_id: null,
          subject_type: 'explore_filter',
          subject_id: command.actor.userId,
          result_code: 'saved',
          metadata_schema_version: 1,
          metadata: { version, genderCount: genderIds.length },
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: generated.processedAt,
        })
        .execute();
      await tx
        .insertInto('platform.outbox_events')
        .values({
          id: generated.eventId,
          aggregate_type: 'explore_filter',
          aggregate_id: command.actor.userId,
          event_type: 'discovery.filter-saved.v1',
          schema_version: 1,
          payload: { userId: command.actor.userId, version },
          occurred_at: generated.processedAt,
          available_at: generated.processedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      await tx
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: generated.processedAt })
        .where('id', '=', command.commandId)
        .execute();
      return result;
    });
  }
}
