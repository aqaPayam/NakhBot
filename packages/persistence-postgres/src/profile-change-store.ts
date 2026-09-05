import { createHash } from 'node:crypto';

import { sql, type Selectable } from 'kysely';

import type {
  ProfileChangeStore,
  RequestProtectedProfileChangeWrite,
  ResolveProtectedProfileChangeWrite,
} from '@nakh/application';
import type {
  ProfileChangeRequest,
  RequestProtectedProfileChangeResult,
  ResolveProtectedProfileChangeResult,
} from '@nakh/contracts';
import {
  ApplicationError,
  evaluateCapability,
  parseGregorianBirthYear,
  PROFILE_LIMITS,
} from '@nakh/domain';

import type { NakhDatabase, ProfileChangeRequestTable } from './database.js';

type ProtectedWrite = RequestProtectedProfileChangeWrite | ResolveProtectedProfileChangeWrite;

function requestHash(write: ProtectedWrite): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: write.command.commandType,
        schemaVersion: write.command.schemaVersion,
        actor: write.command.actor,
        data: write.command.data,
      }),
    )
    .digest('hex');
}

function view(row: Selectable<ProfileChangeRequestTable>): ProfileChangeRequest {
  const common = {
    requestId: row.id,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at.toISOString() }),
  };
  if (row.field_name === 'birth_year') {
    if (typeof row.old_value_snapshot !== 'number' || typeof row.requested_value !== 'number')
      throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 409);
    return {
      ...common,
      field: row.field_name,
      oldValue: row.old_value_snapshot,
      requestedValue: row.requested_value,
    };
  }
  if (typeof row.old_value_snapshot !== 'string' || typeof row.requested_value !== 'string')
    throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 409);
  return {
    ...common,
    field: row.field_name,
    oldValue: row.old_value_snapshot,
    requestedValue: row.requested_value,
  };
}

async function claim(
  database: NakhDatabase,
  write: ProtectedWrite,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const hash = requestHash(write);
  const claimed = await database
    .insertInto('platform.idempotency_records')
    .values({
      id: write.command.commandId,
      actor_user_id: write.command.actor.userId,
      scope: write.command.commandType,
      idempotency_key: write.command.idempotencyKey,
      request_hash: hash,
      status: 'processing',
      response_json: null,
      expires_at: new Date(write.processedAt.getTime() + 86400000),
      created_at: write.processedAt,
      updated_at: write.processedAt,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (claimed !== undefined) return undefined;
  const existing = await database
    .selectFrom('platform.idempotency_records')
    .select(['request_hash', 'status', 'response_json'])
    .where('actor_user_id', '=', write.command.actor.userId)
    .where('scope', '=', write.command.commandType)
    .where('idempotency_key', '=', write.command.idempotencyKey)
    .executeTakeFirstOrThrow();
  if (existing.request_hash !== hash)
    throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
  if (existing.status !== 'completed' || existing.response_json === null)
    throw new ApplicationError('conflict', 'error.command.in_progress', 409);
  return existing.response_json;
}

async function m1ProfileFieldsAreValid(
  database: NakhDatabase,
  profileId: string,
): Promise<boolean> {
  const validity = await database
    .selectFrom('profile.profiles as profile')
    .innerJoin('catalog.gender_options as gender', 'gender.id', 'profile.gender_option_id')
    .innerJoin(
      'catalog.gender_preferences as preference',
      'preference.id',
      'profile.gender_preference_id',
    )
    .innerJoin('catalog.relationship_goals as goal', 'goal.id', 'profile.relationship_goal_id')
    .innerJoin('catalog.countries as country', 'country.id', 'profile.country_id')
    .innerJoin('catalog.provinces as province', 'province.id', 'profile.province_id')
    .innerJoin('catalog.cities as city', 'city.id', 'profile.city_id')
    .select([
      'gender.is_active as genderActive',
      'preference.is_active as preferenceActive',
      'goal.is_active as goalActive',
      'country.is_active as countryActive',
      'province.is_active as provinceActive',
      'city.is_active as cityActive',
    ])
    .where('profile.id', '=', profileId)
    .executeTakeFirstOrThrow();
  const interests = await database
    .selectFrom('profile.profile_interests as selection')
    .innerJoin('catalog.interests as interest', 'interest.id', 'selection.interest_id')
    .select(({ fn }) => [
      fn.countAll<number>().as('total'),
      fn.count<number>('interest.id').filterWhere('interest.is_active', '=', true).as('active'),
    ])
    .where('selection.profile_id', '=', profileId)
    .executeTakeFirstOrThrow();
  return (
    Object.values(validity).every(Boolean) &&
    Number(interests.total) >= PROFILE_LIMITS.minimumInterests &&
    Number(interests.total) <= PROFILE_LIMITS.maximumInterests &&
    Number(interests.total) === Number(interests.active)
  );
}

export class PostgresProfileChangeStore implements ProfileChangeStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async requestProtectedChange(
    write: RequestProtectedProfileChangeWrite,
  ): Promise<RequestProtectedProfileChangeResult> {
    if (write.command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const userId = write.command.actor.userId;
    return this.database.transaction().execute(async (transaction) => {
      const replay = await claim(transaction, write);
      if (replay !== undefined)
        return {
          ...(replay as unknown as RequestProtectedProfileChangeResult),
          replayed: true,
        };
      await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const account = await transaction
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const settings = await transaction
        .selectFrom('identity.user_settings')
        .select('visibility_enabled')
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const profile = await transaction
        .selectFrom('profile.profiles as profile')
        .innerJoin('catalog.gender_options as gender', 'gender.id', 'profile.gender_option_id')
        .select([
          'profile.id',
          'profile.birth_year',
          'profile.completion_status',
          'profile.version',
          'gender.code as genderCode',
        ])
        .where('profile.user_id', '=', userId)
        .forUpdate('profile')
        .executeTakeFirstOrThrow();
      const capability = evaluateCapability(
        {
          accountState: account.state,
          profileCompletion: profile.completion_status,
          visibilityEnabled: settings.visibility_enabled,
        },
        'edit_profile',
      );
      if (!capability.allowed)
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      if (profile.version !== write.command.data.expectedProfileVersion)
        throw new ApplicationError('version_conflict', 'error.profile.version_conflict', 409, {
          currentVersion: String(profile.version),
        });
      const oldValue =
        write.normalized.field === 'birth_year' ? profile.birth_year : profile.genderCode;
      if (oldValue === write.normalized.requestedValue)
        throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 409);
      if (write.normalized.field === 'gender') {
        const active = await transaction
          .selectFrom('catalog.gender_options')
          .select('id')
          .where('code', '=', write.normalized.requestedValue)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (active === undefined)
          throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 400);
      }
      const inserted = await transaction
        .insertInto('profile.profile_change_requests')
        .values({
          id: write.profileChangeRequestId,
          user_id: userId,
          field_name: write.normalized.field,
          old_value_snapshot: sql<number | string>`${JSON.stringify(oldValue)}::jsonb`,
          requested_value: sql<number | string>`${JSON.stringify(
            write.normalized.requestedValue,
          )}::jsonb`,
          value_schema_version: 1,
          reason: write.normalized.reason,
          status: 'pending',
          submitted_at: write.processedAt,
          resolved_at: null,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined)
        throw new ApplicationError(
          'pending_profile_change_exists',
          'error.profile.change.pending',
          409,
        );
      const result: RequestProtectedProfileChangeResult = {
        request: view(inserted),
        replayed: false,
      };
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'account',
          event_type: 'profile.protected-change-requested.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'profile_change_request',
          subject_id: inserted.id,
          result_code: 'pending',
          metadata_schema_version: 1,
          metadata: { field: inserted.field_name },
          request_id: write.command.requestId,
          command_id: write.command.commandId,
          occurred_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'profile_change_request',
          aggregate_id: inserted.id,
          event_type: 'profile.protected-change-requested.v1',
          schema_version: 1,
          payload: {
            profileChangeRequestId: inserted.id,
            userId,
            field: inserted.field_name,
            status: inserted.status,
          },
          occurred_at: write.processedAt,
          available_at: write.processedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.command.requestId,
          causation_id: write.command.commandId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: write.processedAt })
        .where('id', '=', write.command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  public async resolveProtectedChange(
    write: ResolveProtectedProfileChangeWrite,
  ): Promise<ResolveProtectedProfileChangeResult> {
    const actor = write.command.actor;
    if (actor.kind !== 'admin' || actor.userId !== write.authorization.reviewerUserId)
      throw new ApplicationError(
        'reviewer_unauthorized',
        'error.profile.change.reviewer_unauthorized',
        403,
      );
    return this.database.transaction().execute(async (transaction) => {
      const replay = await claim(transaction, write);
      if (replay !== undefined)
        return {
          ...(replay as unknown as ResolveProtectedProfileChangeResult),
          replayed: true,
        };
      const requestReference = await transaction
        .selectFrom('profile.profile_change_requests')
        .select('user_id')
        .where('id', '=', write.command.data.profileChangeRequestId)
        .executeTakeFirst();
      if (requestReference === undefined)
        throw new ApplicationError('not_found', 'error.profile.change.not_found', 404);
      const admin = await transaction
        .selectFrom('administration.admin_users')
        .select('id')
        .where('id', '=', write.authorization.adminUserId)
        .where('user_id', '=', actor.userId)
        .where('is_active', '=', true)
        .forUpdate()
        .executeTakeFirst();
      if (admin === undefined)
        throw new ApplicationError(
          'reviewer_unauthorized',
          'error.profile.change.reviewer_unauthorized',
          403,
        );
      const account = await transaction
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', requestReference.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const profile = await transaction
        .selectFrom('profile.profiles as profile')
        .innerJoin('catalog.gender_options as gender', 'gender.id', 'profile.gender_option_id')
        .select([
          'profile.id',
          'profile.birth_year',
          'profile.completion_status',
          'profile.version',
          'gender.code as genderCode',
        ])
        .where('profile.user_id', '=', requestReference.user_id)
        .forUpdate('profile')
        .executeTakeFirstOrThrow();
      const request = await transaction
        .selectFrom('profile.profile_change_requests')
        .selectAll()
        .where('id', '=', write.command.data.profileChangeRequestId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const review = await transaction
        .selectFrom('profile.profile_change_reviews')
        .select('request_id')
        .where('request_id', '=', request.id)
        .forUpdate()
        .executeTakeFirst();
      if (request.status !== 'pending' || review !== undefined)
        throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 409);
      const currentValue =
        request.field_name === 'birth_year' ? profile.birth_year : profile.genderCode;
      if (currentValue !== request.old_value_snapshot)
        throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 409);

      let profileVersion = profile.version;
      if (write.command.data.decision === 'approved') {
        if (account.state !== 'active' && account.state !== 'restricted')
          throw new ApplicationError('profile_change_invalid', 'error.profile.change.invalid', 409);
        if (request.field_name === 'birth_year') {
          if (typeof request.requested_value !== 'number')
            throw new ApplicationError(
              'profile_change_invalid',
              'error.profile.change.invalid',
              409,
            );
          const birthYear = parseGregorianBirthYear(String(request.requested_value), {
            now: () => write.processedAt,
          });
          await transaction
            .updateTable('profile.profiles')
            .set({
              birth_year: birthYear,
              version: profile.version + 1,
              updated_at: write.processedAt,
            })
            .where('id', '=', profile.id)
            .executeTakeFirstOrThrow();
        } else {
          if (typeof request.requested_value !== 'string')
            throw new ApplicationError(
              'profile_change_invalid',
              'error.profile.change.invalid',
              409,
            );
          const gender = await transaction
            .selectFrom('catalog.gender_options')
            .select('id')
            .where('code', '=', request.requested_value)
            .where('is_active', '=', true)
            .executeTakeFirst();
          if (gender === undefined)
            throw new ApplicationError(
              'profile_change_invalid',
              'error.profile.change.invalid',
              409,
            );
          await transaction
            .updateTable('profile.profiles')
            .set({
              gender_option_id: gender.id,
              version: profile.version + 1,
              updated_at: write.processedAt,
            })
            .where('id', '=', profile.id)
            .executeTakeFirstOrThrow();
        }
        profileVersion += 1;
        const valid = await m1ProfileFieldsAreValid(transaction, profile.id);
        const completionStatus = valid ? 'complete' : 'invalid';
        if (completionStatus !== profile.completion_status)
          await transaction
            .updateTable('profile.profiles')
            .set({ completion_status: completionStatus })
            .where('id', '=', profile.id)
            .executeTakeFirstOrThrow();
      }

      await transaction
        .insertInto('profile.profile_change_reviews')
        .values({
          request_id: request.id,
          admin_user_id: admin.id,
          decision: write.command.data.decision,
          admin_note: write.normalizedNote ?? null,
          reviewed_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      const closed = await transaction
        .updateTable('profile.profile_change_requests')
        .set({ status: write.command.data.decision, resolved_at: write.processedAt })
        .where('id', '=', request.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const result: ResolveProtectedProfileChangeResult = {
        request: view(closed),
        decision: write.command.data.decision,
        profileVersion,
        replayed: false,
      };
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'admin',
          event_type: 'profile.protected-change-reviewed.v1',
          actor_type: 'admin',
          actor_user_id: null,
          actor_admin_id: admin.id,
          subject_type: 'profile_change_request',
          subject_id: request.id,
          result_code: write.command.data.decision,
          metadata_schema_version: 1,
          metadata: { field: request.field_name, decision: write.command.data.decision },
          request_id: write.command.requestId,
          command_id: write.command.commandId,
          occurred_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'profile_change_request',
          aggregate_id: request.id,
          event_type: 'profile.protected-change-reviewed.v1',
          schema_version: 1,
          payload: {
            profileChangeRequestId: request.id,
            userId: request.user_id,
            field: request.field_name,
            decision: write.command.data.decision,
            profileVersion,
          },
          occurred_at: write.processedAt,
          available_at: write.processedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.command.requestId,
          causation_id: write.command.commandId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: write.processedAt })
        .where('id', '=', write.command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  public async getProtectedChangeRequest(
    userId: string,
    profileChangeRequestId: string,
  ): Promise<ProfileChangeRequest | undefined> {
    const row = await this.database
      .selectFrom('profile.profile_change_requests')
      .selectAll()
      .where('id', '=', profileChangeRequestId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row === undefined ? undefined : view(row);
  }
}
