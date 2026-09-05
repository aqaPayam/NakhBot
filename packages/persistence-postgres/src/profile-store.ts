import { createHash } from 'node:crypto';

import type {
  ConfirmSignupWrite,
  ConfirmationMediaSelection,
  ProfileStore,
  UpdateProfileWrite,
} from '@nakh/application';
import type { ConfirmSignupResult, OwnProfile } from '@nakh/contracts';
import {
  ApplicationError,
  assertAccountTransition,
  evaluateCapability,
  normalizeHumanText,
  PROFILE_LIMITS,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type Json = Readonly<Record<string, unknown>>;
type CompleteDraft = Readonly<{
  name: string;
  birthYear: number;
  genderCode: string;
  preferenceCode: string;
  interestCodes: readonly string[];
  countryCode: string;
  provinceCode: string;
  cityCode: string;
  goalCode: string;
  primaryMediaAssetId: string;
  additionalMediaAssetIds: readonly string[];
  highlight: string;
  optional: Json;
}>;

function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ApplicationError('profile_incomplete', 'error.signup.draft_invalid', 409);
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new ApplicationError('profile_incomplete', 'error.signup.draft_invalid', 409);
  return value;
}
function texts(value: unknown): readonly string[] {
  if (!Array.isArray(value))
    throw new ApplicationError('profile_incomplete', 'error.signup.draft_invalid', 409);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string')
      throw new ApplicationError('profile_incomplete', 'error.signup.draft_invalid', 409);
    result.push(item);
  }
  return result;
}
function completeDraft(value: Json, schemaVersion: number): CompleteDraft {
  if (schemaVersion !== 1)
    throw new ApplicationError('profile_incomplete', 'error.signup.draft_invalid', 409);
  const name = record(value.name);
  const birth = record(value.birth_year);
  const gender = record(value.gender);
  const preference = record(value.relationship_gender_preference);
  const interests = record(value.interests);
  const location = record(value.location);
  const goal = record(value.relationship_goal);
  const primary = record(value.primary_photo);
  const additional = record(value.additional_photos);
  const highlight = record(value.highlight);
  const optional = record(record(value.optional_details).value);
  if (!Number.isInteger(birth.value))
    throw new ApplicationError('profile_incomplete', 'error.signup.draft_invalid', 409);
  return {
    name: text(name.value),
    birthYear: Number(birth.value),
    genderCode: text(gender.code),
    preferenceCode: text(preference.code),
    interestCodes: texts(interests.codes),
    countryCode: text(location.countryCode),
    provinceCode: text(location.provinceCode),
    cityCode: text(location.cityCode),
    goalCode: text(goal.code),
    primaryMediaAssetId: text(primary.mediaAssetId),
    additionalMediaAssetIds: texts(additional.mediaAssetIds),
    highlight: text(highlight.value),
    optional,
  };
}

function hash(write: ConfirmSignupWrite | UpdateProfileWrite): string {
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

export class PostgresProfileStore implements ProfileStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async getConfirmationMedia(userId: string): Promise<ConfirmationMediaSelection> {
    const row = await this.database
      .selectFrom('identity.signup_drafts as draft')
      .innerJoin('identity.signup_progress as progress', 'progress.user_id', 'draft.user_id')
      .select(['draft.draft_data', 'draft.schema_version', 'progress.current_step'])
      .where('draft.user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined || row.current_step !== 'confirm_profile')
      throw new ApplicationError('profile_incomplete', 'error.signup.step.invalid', 409);
    const draft = completeDraft(row.draft_data, row.schema_version);
    return {
      primaryMediaAssetId: draft.primaryMediaAssetId,
      additionalMediaAssetIds: draft.additionalMediaAssetIds,
    };
  }

  private async claim(
    database: NakhDatabase,
    write: ConfirmSignupWrite,
  ): Promise<ConfirmSignupResult | undefined> {
    const actor = write.command.actor;
    if (actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const requestHash = hash(write);
    const claimed = await database
      .insertInto('platform.idempotency_records')
      .values({
        id: write.command.commandId,
        actor_user_id: actor.userId,
        scope: write.command.commandType,
        idempotency_key: write.command.idempotencyKey,
        request_hash: requestHash,
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
      .where('actor_user_id', '=', actor.userId)
      .where('scope', '=', write.command.commandType)
      .where('idempotency_key', '=', write.command.idempotencyKey)
      .executeTakeFirstOrThrow();
    if (existing.request_hash !== requestHash)
      throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
    if (existing.status !== 'completed' || existing.response_json === null)
      throw new ApplicationError('conflict', 'error.command.in_progress', 409);
    return { ...(existing.response_json as unknown as ConfirmSignupResult), replayed: true };
  }

  private async claimUpdate(
    database: NakhDatabase,
    write: UpdateProfileWrite,
  ): Promise<OwnProfile | undefined> {
    const actor = write.command.actor;
    if (actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const requestHash = hash(write);
    const claimed = await database
      .insertInto('platform.idempotency_records')
      .values({
        id: write.command.commandId,
        actor_user_id: actor.userId,
        scope: write.command.commandType,
        idempotency_key: write.command.idempotencyKey,
        request_hash: requestHash,
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
      .where('actor_user_id', '=', actor.userId)
      .where('scope', '=', write.command.commandType)
      .where('idempotency_key', '=', write.command.idempotencyKey)
      .executeTakeFirstOrThrow();
    if (existing.request_hash !== requestHash)
      throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
    if (existing.status !== 'completed' || existing.response_json === null)
      throw new ApplicationError('conflict', 'error.command.in_progress', 409);
    return existing.response_json as unknown as OwnProfile;
  }

  private verifyProof(write: ConfirmSignupWrite, draft: CompleteDraft): void {
    const proof = write.proof;
    const selected = [draft.primaryMediaAssetId, ...draft.additionalMediaAssetIds];
    if (
      proof.userId !== write.command.actor.userId ||
      proof.primaryMediaAssetId !== draft.primaryMediaAssetId ||
      proof.issuedAt > write.processedAt ||
      proof.expiresAt < write.processedAt ||
      selected.length < PROFILE_LIMITS.minimumPhotos ||
      selected.length > PROFILE_LIMITS.maximumPhotos ||
      new Set(selected).size !== selected.length ||
      proof.acceptedMediaAssetIds.length !== selected.length ||
      selected.some((id) => !proof.acceptedMediaAssetIds.includes(id))
    )
      throw new ApplicationError('media_not_eligible', 'error.profile.media_not_eligible', 409);
  }

  private async activeId(
    database: NakhDatabase,
    table:
      | 'catalog.gender_options'
      | 'catalog.gender_preferences'
      | 'catalog.relationship_goals'
      | 'catalog.interests'
      | 'catalog.languages'
      | 'catalog.personality_tags',
    code: string,
  ): Promise<string> {
    const row = await database
      .selectFrom(table)
      .select('id')
      .where('code', '=', code)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (row === undefined)
      throw new ApplicationError(
        'inactive_catalog_selection',
        'error.signup.catalog_inactive',
        409,
      );
    return row.id;
  }

  public async confirmSignup(write: ConfirmSignupWrite): Promise<ConfirmSignupResult> {
    if (write.command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const userId = write.command.actor.userId;
    return this.database.transaction().execute(async (transaction) => {
      const replay = await this.claim(transaction, write);
      if (replay !== undefined) return replay;
      await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const account = await transaction
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const progress = await transaction
        .selectFrom('identity.signup_progress')
        .select(['current_step', 'version'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const draftRow = await transaction
        .selectFrom('identity.signup_drafts')
        .select(['draft_data', 'schema_version', 'version'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .selectFrom('profile.profiles')
        .select('id')
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (account.state !== 'incomplete' || progress.current_step !== 'confirm_profile')
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      if (draftRow.version !== write.command.data.expectedDraftVersion)
        throw new ApplicationError('stale_signup_version', 'error.signup.version_conflict', 409, {
          currentVersion: String(draftRow.version),
          currentStep: progress.current_step,
        });
      const draft = completeDraft(draftRow.draft_data, draftRow.schema_version);
      this.verifyProof(write, draft);
      const [genderId, preferenceId, goalId] = await Promise.all([
        this.activeId(transaction, 'catalog.gender_options', draft.genderCode),
        this.activeId(transaction, 'catalog.gender_preferences', draft.preferenceCode),
        this.activeId(transaction, 'catalog.relationship_goals', draft.goalCode),
      ]);
      const location = await transaction
        .selectFrom('catalog.cities as city')
        .innerJoin('catalog.provinces as province', 'province.id', 'city.province_id')
        .innerJoin('catalog.countries as country', 'country.id', 'province.country_id')
        .select(['country.id as countryId', 'province.id as provinceId', 'city.id as cityId'])
        .where('country.code', '=', draft.countryCode)
        .where('province.code', '=', draft.provinceCode)
        .where('city.code', '=', draft.cityCode)
        .where('country.is_active', '=', true)
        .where('province.is_active', '=', true)
        .where('city.is_active', '=', true)
        .executeTakeFirst();
      if (location === undefined)
        throw new ApplicationError('invalid_location', 'error.signup.location_invalid', 409);
      const interestIds = await Promise.all(
        draft.interestCodes.map((code) => this.activeId(transaction, 'catalog.interests', code)),
      );
      if (
        interestIds.length < PROFILE_LIMITS.minimumInterests ||
        interestIds.length > PROFILE_LIMITS.maximumInterests ||
        new Set(draft.interestCodes).size !== draft.interestCodes.length
      )
        throw new ApplicationError('profile_incomplete', 'error.profile.interests.invalid', 409);
      const languageCodes = Array.isArray(draft.optional.languageCodes)
        ? texts(draft.optional.languageCodes)
        : [];
      const tagCodes = Array.isArray(draft.optional.personalityTagCodes)
        ? texts(draft.optional.personalityTagCodes)
        : [];
      if (
        languageCodes.length > PROFILE_LIMITS.maximumLanguages ||
        new Set(languageCodes).size !== languageCodes.length ||
        tagCodes.length > PROFILE_LIMITS.maximumPersonalityTags ||
        new Set(tagCodes).size !== tagCodes.length
      )
        throw new ApplicationError(
          'profile_incomplete',
          'error.signup.optional_details.invalid',
          409,
        );
      const languageIds = await Promise.all(
        languageCodes.map((code) => this.activeId(transaction, 'catalog.languages', code)),
      );
      const tagIds = await Promise.all(
        tagCodes.map((code) => this.activeId(transaction, 'catalog.personality_tags', code)),
      );
      for (const [category, code] of [
        ['education_level', draft.optional.educationLevelCode],
        ['smoking_preference', draft.optional.smokingPreferenceCode],
        ['pets_preference', draft.optional.petsPreferenceCode],
        ['exercise_frequency', draft.optional.exerciseFrequencyCode],
        ['religion_importance', draft.optional.religionCode],
        ['children_preference', draft.optional.childrenPreferenceCode],
      ] as const) {
        if (
          typeof code === 'string' &&
          (await transaction
            .selectFrom('catalog.profile_option_values')
            .select('id')
            .where('category', '=', category)
            .where('code', '=', code)
            .where('is_active', '=', true)
            .executeTakeFirst()) === undefined
        )
          throw new ApplicationError(
            'inactive_catalog_selection',
            'error.signup.catalog_inactive',
            409,
          );
      }
      await transaction
        .insertInto('profile.profiles')
        .values({
          id: write.profileId,
          user_id: userId,
          name: draft.name,
          birth_year: draft.birthYear,
          gender_option_id: genderId,
          gender_preference_id: preferenceId,
          relationship_goal_id: goalId,
          country_id: location.countryId,
          province_id: location.provinceId,
          city_id: location.cityId,
          highlight: draft.highlight,
          bio: typeof draft.optional.bio === 'string' ? draft.optional.bio : null,
          completion_status: 'complete',
          ever_completed: true,
          completed_at: write.processedAt,
          version: 1,
          created_at: write.processedAt,
          updated_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('profile.profile_optional_details')
        .values({
          profile_id: write.profileId,
          height_cm: typeof draft.optional.heightCm === 'number' ? draft.optional.heightCm : null,
          job_title: typeof draft.optional.job === 'string' ? draft.optional.job : null,
          education_level_code:
            typeof draft.optional.educationLevelCode === 'string'
              ? draft.optional.educationLevelCode
              : null,
          smoking_preference_code:
            typeof draft.optional.smokingPreferenceCode === 'string'
              ? draft.optional.smokingPreferenceCode
              : null,
          pets_preference_code:
            typeof draft.optional.petsPreferenceCode === 'string'
              ? draft.optional.petsPreferenceCode
              : null,
          exercise_frequency_code:
            typeof draft.optional.exerciseFrequencyCode === 'string'
              ? draft.optional.exerciseFrequencyCode
              : null,
          religion_importance_code:
            typeof draft.optional.religionCode === 'string' ? draft.optional.religionCode : null,
          children_preference_code:
            typeof draft.optional.childrenPreferenceCode === 'string'
              ? draft.optional.childrenPreferenceCode
              : null,
        })
        .executeTakeFirstOrThrow();
      if (interestIds.length > 0)
        await transaction
          .insertInto('profile.profile_interests')
          .values(interestIds.map((interest_id) => ({ profile_id: write.profileId, interest_id })))
          .execute();
      if (languageIds.length > 0)
        await transaction
          .insertInto('profile.profile_languages')
          .values(languageIds.map((language_id) => ({ profile_id: write.profileId, language_id })))
          .execute();
      if (tagIds.length > 0)
        await transaction
          .insertInto('profile.profile_personality_tags')
          .values(
            tagIds.map((personality_tag_id) => ({
              profile_id: write.profileId,
              personality_tag_id,
            })),
          )
          .execute();
      assertAccountTransition('incomplete', 'active');
      await transaction
        .updateTable('identity.accounts')
        .set({
          state: 'active',
          state_reason: 'signup_confirmed',
          state_changed_at: write.processedAt,
          version: account.version + 1,
        })
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('identity.account_state_history')
        .values({
          id: write.accountHistoryId,
          user_id: userId,
          previous_state: 'incomplete',
          next_state: 'active',
          reason_code: 'signup_confirmed',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          changed_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('identity.signup_progress')
        .set({
          current_step: 'completed',
          completed_at: write.processedAt,
          version: progress.version + 1,
          updated_at: write.processedAt,
        })
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      const profile = await this.readProfile(transaction, userId);
      if (profile === undefined) throw new Error('Profile missing after confirmation.');
      const result: ConfirmSignupResult = { profile, accountState: 'active', replayed: false };
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'account',
          event_type: 'profile.confirmed.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'profile',
          subject_id: write.profileId,
          result_code: 'confirmed',
          metadata_schema_version: 1,
          metadata: { completionStatus: 'complete' },
          request_id: write.command.requestId,
          command_id: write.command.commandId,
          occurred_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      for (const event of [
        {
          id: write.profileEventId,
          type: 'profile.confirmed.v1',
          aggregate: 'profile',
          aggregateId: write.profileId,
        },
        {
          id: write.accountEventId,
          type: 'identity.account-state-changed.v1',
          aggregate: 'user',
          aggregateId: userId,
        },
      ])
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: event.id,
            aggregate_type: event.aggregate,
            aggregate_id: event.aggregateId,
            event_type: event.type,
            schema_version: 1,
            payload: { userId, profileId: write.profileId, accountState: 'active' },
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

  private async readProfile(
    database: NakhDatabase,
    userId: string,
  ): Promise<OwnProfile | undefined> {
    const row = await database
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
        'profile.id',
        'profile.user_id',
        'profile.name',
        'profile.birth_year',
        'gender.code as gender_code',
        'preference.code as preference_code',
        'goal.code as goal_code',
        'country.code as country_code',
        'province.code as province_code',
        'city.code as city_code',
        'profile.highlight',
        'profile.bio',
        'profile.completion_status',
        'profile.version',
      ])
      .where('profile.user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const interests = await database
      .selectFrom('profile.profile_interests as selection')
      .innerJoin('catalog.interests as interest', 'interest.id', 'selection.interest_id')
      .select('interest.code')
      .where('selection.profile_id', '=', row.id)
      .orderBy('interest.display_order')
      .execute();
    return {
      profileId: row.id,
      userId: row.user_id,
      name: row.name,
      birthYear: row.birth_year,
      genderCode: row.gender_code,
      relationshipGenderPreferenceCode: row.preference_code,
      interestCodes: interests.map((item) => item.code),
      countryCode: row.country_code,
      provinceCode: row.province_code,
      cityCode: row.city_code,
      relationshipGoalCode: row.goal_code,
      highlight: row.highlight,
      ...(row.bio === null ? {} : { bio: row.bio }),
      completionStatus: row.completion_status,
      version: row.version,
    };
  }
  public getOwnProfile(userId: string): Promise<OwnProfile | undefined> {
    return this.readProfile(this.database, userId);
  }

  public async updateOwnProfile(write: UpdateProfileWrite): Promise<OwnProfile> {
    if (write.command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const userId = write.command.actor.userId;
    return this.database.transaction().execute(async (transaction) => {
      const replay = await this.claimUpdate(transaction, write);
      if (replay !== undefined) return replay;
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
      const current = await transaction
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const decision = evaluateCapability(
        {
          accountState: account.state,
          profileCompletion: current.completion_status,
          visibilityEnabled: settings.visibility_enabled,
        },
        'edit_profile',
      );
      if (!decision.allowed)
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      if (current.version !== write.command.data.expectedProfileVersion)
        throw new ApplicationError('version_conflict', 'error.profile.version_conflict', 409, {
          currentVersion: String(current.version),
        });
      const patch = write.command.data.patch;
      const currentView = await this.readProfile(transaction, userId);
      if (currentView === undefined) throw new Error('Profile missing before update.');
      const preferenceId =
        patch.relationshipGenderPreferenceCode === undefined
          ? current.gender_preference_id
          : await this.activeId(
              transaction,
              'catalog.gender_preferences',
              patch.relationshipGenderPreferenceCode,
            );
      const goalId =
        patch.relationshipGoalCode === undefined
          ? current.relationship_goal_id
          : await this.activeId(
              transaction,
              'catalog.relationship_goals',
              patch.relationshipGoalCode,
            );
      let location = {
        countryId: current.country_id,
        provinceId: current.province_id,
        cityId: current.city_id,
      };
      if (
        patch.countryCode !== undefined ||
        patch.provinceCode !== undefined ||
        patch.cityCode !== undefined
      ) {
        const resolved = await transaction
          .selectFrom('catalog.cities as city')
          .innerJoin('catalog.provinces as province', 'province.id', 'city.province_id')
          .innerJoin('catalog.countries as country', 'country.id', 'province.country_id')
          .select(['country.id as countryId', 'province.id as provinceId', 'city.id as cityId'])
          .where('country.code', '=', patch.countryCode ?? currentView.countryCode)
          .where('province.code', '=', patch.provinceCode ?? currentView.provinceCode)
          .where('city.code', '=', patch.cityCode ?? currentView.cityCode)
          .where('country.is_active', '=', true)
          .where('province.is_active', '=', true)
          .where('city.is_active', '=', true)
          .executeTakeFirst();
        if (resolved === undefined)
          throw new ApplicationError('invalid_location', 'error.signup.location_invalid', 400);
        location = resolved;
      }
      await transaction
        .updateTable('profile.profiles')
        .set({
          ...(patch.name === undefined
            ? {}
            : {
                name: normalizeHumanText(patch.name, {
                  path: 'name',
                  minimum: 1,
                  maximum: PROFILE_LIMITS.nameCodePoints,
                }),
              }),
          ...(patch.highlight === undefined
            ? {}
            : {
                highlight: normalizeHumanText(patch.highlight, {
                  path: 'highlight',
                  minimum: 1,
                  maximum: PROFILE_LIMITS.highlightCodePoints,
                }),
              }),
          gender_preference_id: preferenceId,
          relationship_goal_id: goalId,
          country_id: location.countryId,
          province_id: location.provinceId,
          city_id: location.cityId,
          version: current.version + 1,
          updated_at: write.processedAt,
        })
        .where('id', '=', current.id)
        .executeTakeFirstOrThrow();
      if (patch.interestCodes !== undefined) {
        if (
          patch.interestCodes.length < PROFILE_LIMITS.minimumInterests ||
          patch.interestCodes.length > PROFILE_LIMITS.maximumInterests ||
          new Set(patch.interestCodes).size !== patch.interestCodes.length
        )
          throw new ApplicationError('profile_incomplete', 'error.profile.interests.invalid', 400);
        const ids = await Promise.all(
          patch.interestCodes.map((code) => this.activeId(transaction, 'catalog.interests', code)),
        );
        await transaction
          .deleteFrom('profile.profile_interests')
          .where('profile_id', '=', current.id)
          .execute();
        await transaction
          .insertInto('profile.profile_interests')
          .values(ids.map((interest_id) => ({ profile_id: current.id, interest_id })))
          .execute();
      }
      if (patch.optionalDetails !== undefined) {
        const value = patch.optionalDetails;
        if (
          value.heightCm !== undefined &&
          (value.heightCm < PROFILE_LIMITS.minimumHeightCm ||
            value.heightCm > PROFILE_LIMITS.maximumHeightCm)
        )
          throw new ApplicationError(
            'invalid_signup_step',
            'error.signup.optional_details.invalid',
            400,
          );
        const languageCodes = value.languageCodes ?? [];
        const tagCodes = value.personalityTagCodes ?? [];
        if (
          languageCodes.length > PROFILE_LIMITS.maximumLanguages ||
          new Set(languageCodes).size !== languageCodes.length
        )
          throw new ApplicationError('invalid_signup_step', 'error.profile.languages.invalid', 400);
        if (
          tagCodes.length > PROFILE_LIMITS.maximumPersonalityTags ||
          new Set(tagCodes).size !== tagCodes.length
        )
          throw new ApplicationError(
            'invalid_signup_step',
            'error.profile.personality_tags.invalid',
            400,
          );
        const languageIds = await Promise.all(
          languageCodes.map((code) => this.activeId(transaction, 'catalog.languages', code)),
        );
        const tagIds = await Promise.all(
          tagCodes.map((code) => this.activeId(transaction, 'catalog.personality_tags', code)),
        );
        for (const [category, code] of [
          ['education_level', value.educationLevelCode],
          ['smoking_preference', value.smokingPreferenceCode],
          ['pets_preference', value.petsPreferenceCode],
          ['exercise_frequency', value.exerciseFrequencyCode],
          ['religion_importance', value.religionCode],
          ['children_preference', value.childrenPreferenceCode],
        ] as const)
          if (
            code !== undefined &&
            (await transaction
              .selectFrom('catalog.profile_option_values')
              .select('id')
              .where('category', '=', category)
              .where('code', '=', code)
              .where('is_active', '=', true)
              .executeTakeFirst()) === undefined
          )
            throw new ApplicationError(
              'inactive_catalog_selection',
              'error.signup.catalog_inactive',
              400,
            );
        await transaction
          .updateTable('profile.profile_optional_details')
          .set({
            height_cm: value.heightCm ?? null,
            job_title:
              value.job === undefined
                ? null
                : normalizeHumanText(value.job, {
                    path: 'job',
                    maximum: PROFILE_LIMITS.jobCodePoints,
                  }),
            education_level_code: value.educationLevelCode ?? null,
            smoking_preference_code: value.smokingPreferenceCode ?? null,
            pets_preference_code: value.petsPreferenceCode ?? null,
            exercise_frequency_code: value.exerciseFrequencyCode ?? null,
            religion_importance_code: value.religionCode ?? null,
            children_preference_code: value.childrenPreferenceCode ?? null,
          })
          .where('profile_id', '=', current.id)
          .executeTakeFirstOrThrow();
        await transaction
          .deleteFrom('profile.profile_languages')
          .where('profile_id', '=', current.id)
          .execute();
        if (languageIds.length > 0)
          await transaction
            .insertInto('profile.profile_languages')
            .values(languageIds.map((language_id) => ({ profile_id: current.id, language_id })))
            .execute();
        await transaction
          .deleteFrom('profile.profile_personality_tags')
          .where('profile_id', '=', current.id)
          .execute();
        if (tagIds.length > 0)
          await transaction
            .insertInto('profile.profile_personality_tags')
            .values(
              tagIds.map((personality_tag_id) => ({ profile_id: current.id, personality_tag_id })),
            )
            .execute();
        await transaction
          .updateTable('profile.profiles')
          .set({
            bio:
              value.bio === undefined
                ? null
                : normalizeHumanText(value.bio, {
                    path: 'bio',
                    maximum: PROFILE_LIMITS.bioCodePoints,
                  }),
          })
          .where('id', '=', current.id)
          .executeTakeFirstOrThrow();
      }
      const validity = await transaction
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
        .where('profile.id', '=', current.id)
        .executeTakeFirstOrThrow();
      const interestCount = await transaction
        .selectFrom('profile.profile_interests as selection')
        .innerJoin('catalog.interests as interest', 'interest.id', 'selection.interest_id')
        .select(({ fn }) => [
          fn.countAll<number>().as('total'),
          fn.count<number>('interest.id').filterWhere('interest.is_active', '=', true).as('active'),
        ])
        .where('selection.profile_id', '=', current.id)
        .executeTakeFirstOrThrow();
      const complete =
        Object.values(validity).every(Boolean) &&
        Number(interestCount.total) >= PROFILE_LIMITS.minimumInterests &&
        Number(interestCount.total) <= PROFILE_LIMITS.maximumInterests &&
        Number(interestCount.total) === Number(interestCount.active);
      await transaction
        .updateTable('profile.profiles')
        .set({ completion_status: complete ? 'complete' : 'invalid' })
        .where('id', '=', current.id)
        .executeTakeFirstOrThrow();
      const profile = await this.readProfile(transaction, userId);
      if (profile === undefined) throw new Error('Profile missing after update.');
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'account',
          event_type: 'profile.updated.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'profile',
          subject_id: current.id,
          result_code: 'updated',
          metadata_schema_version: 1,
          metadata: { fields: Object.keys(patch).sort().join(',') },
          request_id: write.command.requestId,
          command_id: write.command.commandId,
          occurred_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'profile',
          aggregate_id: current.id,
          event_type: 'profile.updated.v1',
          schema_version: 1,
          payload: { userId, profileId: current.id, version: profile.version },
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
        .set({ status: 'completed', response_json: profile, updated_at: write.processedAt })
        .where('id', '=', write.command.commandId)
        .executeTakeFirstOrThrow();
      return profile;
    });
  }
}
