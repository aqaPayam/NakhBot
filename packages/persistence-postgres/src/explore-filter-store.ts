import { createHash } from 'node:crypto';

import type { ExploreFilterResult, ExploreFilterStore } from '@nakh/application';
import type { SaveExploreFilterCommand } from '@nakh/contracts';
import { ApplicationError, assertExploreFilter } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

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
  public constructor(private readonly database: NakhDatabase) {}

  public saveFilter(
    command: SaveExploreFilterCommand,
    generated: Generated,
  ): Promise<ExploreFilterResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.database.transaction().execute(async (tx) => {
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

      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', command.actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const account = await tx
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', command.actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const profile = await tx
        .selectFrom('profile.profiles')
        .select(['gender_preference_id', 'completion_status'])
        .where('user_id', '=', command.actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (account.state !== 'active' || profile?.completion_status !== 'complete')
        throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
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
        .selectFrom('catalog.cities')
        .select('id')
        .where('id', '=', command.data.cityId)
        .where('is_active', '=', true)
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
