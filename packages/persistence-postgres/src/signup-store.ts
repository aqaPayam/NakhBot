import { createHash } from 'node:crypto';

import type { SaveSignupStepWrite, SignupStore, StartSignupWrite } from '@nakh/application';
import type { SignupState } from '@nakh/contracts';
import {
  ApplicationError,
  assertAccountTransition,
  nextSignupStep,
  normalizeSignupStep,
  type SignupCatalogSnapshot,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type SignupWrite = StartSignupWrite | SaveSignupStepWrite;
const draftSteps = new Set([
  'age_confirmation',
  'name',
  'birth_year',
  'gender',
  'relationship_gender_preference',
  'interests',
  'location',
  'relationship_goal',
  'primary_photo',
  'additional_photos',
  'highlight',
  'optional_details',
]);

function requestHash(write: SignupWrite): string {
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

function signupState(
  currentStep: SignupState['currentStep'],
  draftVersion: number,
  updatedAt: Date,
): SignupState {
  return { currentStep, draftVersion, updatedAt: updatedAt.toISOString() };
}

function parseStoredState(value: Readonly<Record<string, unknown>>): SignupState {
  const currentStep = String(value.currentStep);
  const steps = [
    'age_confirmation',
    'name',
    'birth_year',
    'gender',
    'relationship_gender_preference',
    'interests',
    'location',
    'relationship_goal',
    'primary_photo',
    'additional_photos',
    'highlight',
    'optional_details',
    'confirm_profile',
    'completed',
  ];
  if (!steps.includes(currentStep))
    throw new ApplicationError('internal_error', 'error.signup.draft_invalid', 500);
  return {
    currentStep: currentStep as SignupState['currentStep'],
    draftVersion: Number(value.draftVersion),
    updatedAt: String(value.updatedAt),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(entry: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(entry).every((key) => keys.includes(key));
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validDraftEntry(key: string, entry: Readonly<Record<string, unknown>>): boolean {
  if (entry.step !== key) return false;
  switch (key) {
    case 'age_confirmation':
      return entry.accepted === true && hasOnly(entry, ['step', 'accepted']);
    case 'name':
    case 'highlight':
      return typeof entry.value === 'string' && hasOnly(entry, ['step', 'value']);
    case 'birth_year':
      return Number.isInteger(entry.value) && hasOnly(entry, ['step', 'value']);
    case 'gender':
    case 'relationship_gender_preference':
    case 'relationship_goal':
      return typeof entry.code === 'string' && hasOnly(entry, ['step', 'code']);
    case 'interests':
      return isStringArray(entry.codes) && hasOnly(entry, ['step', 'codes']);
    case 'location':
      return (
        typeof entry.countryCode === 'string' &&
        typeof entry.provinceCode === 'string' &&
        typeof entry.cityCode === 'string' &&
        hasOnly(entry, ['step', 'countryCode', 'provinceCode', 'cityCode'])
      );
    case 'primary_photo':
      return typeof entry.mediaAssetId === 'string' && hasOnly(entry, ['step', 'mediaAssetId']);
    case 'additional_photos':
      return isStringArray(entry.mediaAssetIds) && hasOnly(entry, ['step', 'mediaAssetIds']);
    case 'optional_details': {
      if (!isRecord(entry.value) || !hasOnly(entry, ['step', 'value'])) return false;
      const allowed = [
        'heightCm',
        'job',
        'educationLevelCode',
        'smokingPreferenceCode',
        'petsPreferenceCode',
        'exerciseFrequencyCode',
        'religionCode',
        'childrenPreferenceCode',
        'languageCodes',
        'personalityTagCodes',
        'bio',
      ];
      if (!hasOnly(entry.value, allowed)) return false;
      return Object.entries(entry.value).every(([field, fieldValue]) =>
        field === 'heightCm'
          ? Number.isInteger(fieldValue)
          : field === 'languageCodes' || field === 'personalityTagCodes'
            ? isStringArray(fieldValue)
            : typeof fieldValue === 'string',
      );
    }
    default:
      return false;
  }
}

function decodeDraft(
  value: Readonly<Record<string, unknown>>,
  schemaVersion: number,
): Readonly<Record<string, object>> {
  if (schemaVersion !== 1)
    throw new ApplicationError('internal_error', 'error.signup.draft_invalid', 500);
  const decoded: Record<string, object> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!draftSteps.has(key) || !isRecord(entry) || !validDraftEntry(key, entry))
      throw new ApplicationError('internal_error', 'error.signup.draft_invalid', 500);
    decoded[key] = entry;
  }
  return decoded;
}

export class PostgresSignupStore implements SignupStore {
  public constructor(private readonly database: NakhDatabase) {}

  private async claim(
    database: NakhDatabase,
    write: SignupWrite,
  ): Promise<SignupState | undefined> {
    if (write.command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
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
        expires_at: new Date(write.processedAt.getTime() + 24 * 60 * 60 * 1_000),
        created_at: write.processedAt,
        updated_at: write.processedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(['actor_user_id', 'scope', 'idempotency_key']).doNothing(),
      )
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
    return parseStoredState(existing.response_json);
  }

  private async complete(
    database: NakhDatabase,
    commandId: string,
    state: SignupState,
    processedAt: Date,
  ): Promise<void> {
    await database
      .updateTable('platform.idempotency_records')
      .set({ status: 'completed', response_json: state, updated_at: processedAt })
      .where('id', '=', commandId)
      .executeTakeFirstOrThrow();
  }

  public async getSignupState(userId: string): Promise<SignupState | undefined> {
    const row = await this.database
      .selectFrom('identity.signup_progress as progress')
      .innerJoin('identity.signup_drafts as draft', 'draft.user_id', 'progress.user_id')
      .select([
        'progress.current_step',
        'draft.version as draft_version',
        'draft.draft_data',
        'draft.schema_version',
        'progress.updated_at',
      ])
      .where('progress.user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    decodeDraft(row.draft_data, row.schema_version);
    return signupState(row.current_step, row.draft_version, row.updated_at);
  }

  public async startSignup(write: StartSignupWrite): Promise<SignupState> {
    if (write.command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const userId = write.command.actor.userId;
    return this.database.transaction().execute(async (transaction) => {
      const replay = await this.claim(transaction, write);
      if (replay !== undefined) return replay;
      const user = await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined)
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      const account = await transaction
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (account.state !== 'guest' && account.state !== 'incomplete')
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      if (
        account.state === 'guest' &&
        account.version !== write.command.data.expectedAccountVersion
      )
        throw new ApplicationError('version_conflict', 'error.signup.version_conflict', 409, {
          currentVersion: String(account.version),
        });

      const transitioned = account.state === 'guest';
      if (transitioned) {
        assertAccountTransition(account.state, 'incomplete');
        await transaction
          .updateTable('identity.accounts')
          .set({
            state: 'incomplete',
            state_reason: 'signup_started',
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
            previous_state: 'guest',
            next_state: 'incomplete',
            reason_code: 'signup_started',
            actor_type: 'user',
            actor_user_id: userId,
            actor_admin_id: null,
            changed_at: write.processedAt,
          })
          .executeTakeFirstOrThrow();
      }

      await transaction
        .insertInto('identity.signup_progress')
        .values({
          user_id: userId,
          current_step: 'age_confirmation',
          started_at: write.processedAt,
          completed_at: null,
          version: 1,
          updated_at: write.processedAt,
        })
        .onConflict((conflict) => conflict.column('user_id').doNothing())
        .executeTakeFirst();
      await transaction
        .insertInto('identity.signup_drafts')
        .values({
          user_id: userId,
          draft_data: {},
          schema_version: 1,
          last_completed_step: null,
          expires_at: null,
          version: 1,
          created_at: write.processedAt,
          updated_at: write.processedAt,
        })
        .onConflict((conflict) => conflict.column('user_id').doNothing())
        .executeTakeFirst();

      const progress = await transaction
        .selectFrom('identity.signup_progress as progress')
        .innerJoin('identity.signup_drafts as draft', 'draft.user_id', 'progress.user_id')
        .select([
          'progress.current_step',
          'draft.version as draft_version',
          'draft.draft_data',
          'draft.schema_version',
          'progress.updated_at',
        ])
        .where('progress.user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      decodeDraft(progress.draft_data, progress.schema_version);
      const state = signupState(progress.current_step, progress.draft_version, progress.updated_at);
      if (transitioned) {
        await transaction
          .insertInto('platform.audit_logs')
          .values({
            id: write.auditId,
            category: 'account',
            event_type: 'identity.signup-started.v1',
            actor_type: 'user',
            actor_user_id: userId,
            actor_admin_id: null,
            subject_type: 'user',
            subject_id: userId,
            result_code: 'started',
            metadata_schema_version: 1,
            metadata: { currentStep: state.currentStep },
            request_id: write.command.requestId,
            command_id: write.command.commandId,
            occurred_at: write.processedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.eventId,
            aggregate_type: 'user',
            aggregate_id: userId,
            event_type: 'identity.signup-started.v1',
            schema_version: 1,
            payload: { userId, currentStep: state.currentStep, draftVersion: state.draftVersion },
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
      }
      await this.complete(transaction, write.command.commandId, state, write.processedAt);
      return state;
    });
  }

  private async catalogs(database: NakhDatabase): Promise<SignupCatalogSnapshot> {
    const [genders, preferences, goals, interests, languages, tags, options, locations] =
      await Promise.all([
        database
          .selectFrom('catalog.gender_options')
          .select('code')
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.gender_preferences')
          .select('code')
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.relationship_goals')
          .select('code')
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.interests')
          .select('code')
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.languages')
          .select('code')
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.personality_tags')
          .select('code')
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.profile_option_values')
          .select(['category', 'code'])
          .where('is_active', '=', true)
          .execute(),
        database
          .selectFrom('catalog.cities as city')
          .innerJoin('catalog.provinces as province', 'province.id', 'city.province_id')
          .innerJoin('catalog.countries as country', 'country.id', 'province.country_id')
          .select([
            'country.code as countryCode',
            'province.code as provinceCode',
            'city.code as cityCode',
          ])
          .where('country.is_active', '=', true)
          .where('province.is_active', '=', true)
          .where('city.is_active', '=', true)
          .execute(),
      ]);
    const optionCodes: Record<string, string[]> = {};
    for (const option of options) (optionCodes[option.category] ??= []).push(option.code);
    return {
      genderCodes: genders.map((row) => row.code),
      genderPreferenceCodes: preferences.map((row) => row.code),
      relationshipGoalCodes: goals.map((row) => row.code),
      interestCodes: interests.map((row) => row.code),
      languageCodes: languages.map((row) => row.code),
      personalityTagCodes: tags.map((row) => row.code),
      optionCodes,
      locations,
    };
  }

  public async saveSignupStep(write: SaveSignupStepWrite): Promise<SignupState> {
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
        .select('state')
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (account.state !== 'incomplete')
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
      const progress = await transaction
        .selectFrom('identity.signup_progress')
        .select(['current_step', 'version'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const draft = await transaction
        .selectFrom('identity.signup_drafts')
        .select(['draft_data', 'schema_version', 'version'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (draft.version !== write.command.data.expectedDraftVersion)
        throw new ApplicationError('stale_signup_version', 'error.signup.version_conflict', 409, {
          currentStep: progress.current_step,
          currentVersion: String(draft.version),
        });
      if (
        progress.current_step !== write.command.data.value.step ||
        progress.current_step === 'confirm_profile'
      )
        throw new ApplicationError('invalid_signup_step', 'error.signup.step.invalid', 409, {
          currentStep: progress.current_step,
        });

      const normalized = normalizeSignupStep(
        write.command.data.value,
        await this.catalogs(transaction),
        { now: () => write.processedAt },
      );
      const currentDraft = decodeDraft(draft.draft_data, draft.schema_version);
      const nextStep = nextSignupStep(progress.current_step);
      const nextVersion = draft.version + 1;
      await transaction
        .updateTable('identity.signup_drafts')
        .set({
          draft_data: { ...currentDraft, [normalized.step]: normalized },
          last_completed_step: progress.current_step,
          version: nextVersion,
          updated_at: write.processedAt,
        })
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('identity.signup_progress')
        .set({
          current_step: nextStep,
          version: progress.version + 1,
          updated_at: write.processedAt,
        })
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();

      const state = signupState(nextStep, nextVersion, write.processedAt);
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'account',
          event_type: 'identity.signup-step-saved.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'signup_draft',
          subject_id: userId,
          result_code: 'saved',
          metadata_schema_version: 1,
          metadata: { completedStep: normalized.step, nextStep },
          request_id: write.command.requestId,
          command_id: write.command.commandId,
          occurred_at: write.processedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'user',
          aggregate_id: userId,
          event_type: 'identity.signup-step-saved.v1',
          schema_version: 1,
          payload: {
            userId,
            completedStep: normalized.step,
            currentStep: state.currentStep,
            draftVersion: state.draftVersion,
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
      await this.complete(transaction, write.command.commandId, state, write.processedAt);
      return state;
    });
  }
}
