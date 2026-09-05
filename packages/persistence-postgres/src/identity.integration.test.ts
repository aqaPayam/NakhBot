import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ChangeVisibilityCommand,
  RequestProtectedProfileChangeCommand,
  ResolveProtectedProfileChangeCommand,
  SaveSignupStepCommand,
} from '@nakh/contracts';
import {
  RegisterTelegramIdentityHandler,
  type ChangeSettingsWrite,
  type ConfirmSignupWrite,
  type RegisterTelegramIdentityWrite,
  type RequestProtectedProfileChangeWrite,
  type ResolveProtectedProfileChangeWrite,
  type SaveSignupStepWrite,
  type StartSignupWrite,
  type UpdateProfileWrite,
} from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresIdentityStore, PostgresLocalizationStore } from './identity-store.js';
import { runMigrations } from './migrations.js';
import { PostgresSignupStore } from './signup-store.js';
import { PostgresProfileStore } from './profile-store.js';
import { PostgresProfileChangeStore } from './profile-change-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

function telegramUserId(): string {
  return String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000));
}

function registrationWrite(
  telegramId: string,
  index: number,
  userId = randomUUID(),
): RegisterTelegramIdentityWrite {
  const processedAt = new Date('2026-09-04T09:00:00.000Z');
  return {
    command: {
      commandId: randomUUID(),
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { userId: '00000000-0000-4000-8000-000000000001', kind: 'system' },
      requestId: randomUUID(),
      idempotencyKey: `telegram-update:${telegramId}-${index}`,
      occurredAt: processedAt.toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: telegramId },
      data: {
        telegramUserId: telegramId,
        updateId: `${telegramId}-${index}`,
        username: `race_${index}`,
      },
    },
    userId,
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    registrationEventId: randomUUID(),
    startRouteEventId: randomUUID(),
    processedAt,
    guestPreviewLimit: 10,
    defaultLocale: 'en',
  };
}

function visibilityWrite(
  userId: string,
  index: number,
  visibilityEnabled: boolean,
  expectedSettingsVersion: number,
): ChangeSettingsWrite & Readonly<{ command: ChangeVisibilityCommand }> {
  const processedAt = new Date(`2026-09-04T10:00:${String(index).padStart(2, '0')}.000Z`);
  return {
    command: {
      commandId: randomUUID(),
      commandType: 'identity.change-visibility',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `visibility:${userId}:${index}`,
      occurredAt: processedAt.toISOString(),
      locale: 'en',
      data: { visibilityEnabled, expectedSettingsVersion },
    },
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt,
  };
}

function localeWrite(
  userId: string,
  index: number,
  locale: string,
  expectedSettingsVersion: number,
): ChangeSettingsWrite {
  const processedAt = new Date(`2026-09-04T10:01:${String(index).padStart(2, '0')}.000Z`);
  return {
    command: {
      commandId: randomUUID(),
      commandType: 'identity.change-locale',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `locale:${userId}:${index}`,
      occurredAt: processedAt.toISOString(),
      locale: 'en',
      data: { locale, expectedSettingsVersion },
    },
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt,
  };
}

function startSignupWrite(userId: string, index: number): StartSignupWrite {
  const processedAt = new Date(`2026-09-04T11:00:${String(index).padStart(2, '0')}.000Z`);
  return {
    command: {
      commandId: randomUUID(),
      commandType: 'identity.start-signup',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `start-signup:${userId}:${index}`,
      occurredAt: processedAt.toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: 1 },
    },
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt,
  };
}

function saveSignupWrite(
  userId: string,
  index: number,
  expectedDraftVersion: number,
  value: SaveSignupStepCommand['data']['value'],
): SaveSignupStepWrite {
  const processedAt = new Date(`2026-09-04T11:01:${String(index).padStart(2, '0')}.000Z`);
  return {
    command: {
      commandId: randomUUID(),
      commandType: 'identity.save-signup-step',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `save-signup:${userId}:${index}`,
      occurredAt: processedAt.toISOString(),
      locale: 'en',
      data: { expectedDraftVersion, value },
    },
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt,
  };
}

describe.skipIf(databaseUrl === undefined)('M1 identity and localization persistence', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('installs the locked locales and complete initial English catalog', async () => {
    const locales = await database
      .selectFrom('catalog.locales')
      .select(['code', 'is_active', 'is_default'])
      .orderBy('code')
      .execute();
    expect(locales).toEqual([
      { code: 'en', is_active: true, is_default: true },
      { code: 'fa', is_active: false, is_default: false },
    ]);

    const store = new PostgresLocalizationStore(database);
    const english = await store.loadActiveCatalog('en');
    const inactiveFallback = await store.loadActiveCatalog('fa');
    expect(Object.keys(english.messages)).toHaveLength(159);
    expect(english.messages['start.guest.title']).toBe('Welcome to Nakh');
    expect(inactiveFallback).toMatchObject({ requestedLocale: 'fa', resolvedLocale: 'en' });
  });

  it('installs canonical Profile catalogs with unique codes and valid hierarchy', async () => {
    const counts = await Promise.all([
      database
        .selectFrom('catalog.gender_options')
        .select('id')
        .where('is_active', '=', true)
        .execute(),
      database
        .selectFrom('catalog.gender_preferences')
        .select('id')
        .where('is_active', '=', true)
        .execute(),
      database
        .selectFrom('catalog.relationship_goals')
        .select('id')
        .where('is_active', '=', true)
        .execute(),
      database.selectFrom('catalog.interests').select('id').where('is_active', '=', true).execute(),
      database.selectFrom('catalog.languages').select('id').where('is_active', '=', true).execute(),
      database
        .selectFrom('catalog.personality_tags')
        .select('id')
        .where('is_active', '=', true)
        .execute(),
    ]);
    expect(counts.map((rows) => rows.length)).toEqual([3, 3, 5, 30, 14, 12]);
    await expect(
      database
        .insertInto('catalog.interests')
        .values({
          id: randomUUID(),
          code: 'music',
          label_key: 'catalog.interest.duplicate_music',
          is_active: true,
          display_order: 999,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('creates the entire first-start aggregate atomically', async () => {
    const store = new PostgresIdentityStore(database);
    const userId = randomUUID();
    const write = registrationWrite(telegramUserId(), 1, userId);
    const result = await store.registerTelegramIdentity(write);
    const replay = await store.registerTelegramIdentity({
      ...write,
      userId: randomUUID(),
      accountHistoryId: randomUUID(),
      auditId: randomUUID(),
      registrationEventId: randomUUID(),
      startRouteEventId: randomUUID(),
    });

    expect(result).toMatchObject({
      created: true,
      context: {
        userId,
        accountState: 'guest',
        profileCompletion: null,
        visibilityEnabled: true,
        uiLocale: 'en',
        guestPreviewCount: 0,
        guestPreviewLimit: 10,
        entryRoute: 'guest',
      },
    });
    expect(replay).toMatchObject({ created: true, replayed: true, context: { userId } });
    await expect(
      store.registerTelegramIdentity({
        ...write,
        command: {
          ...write.command,
          data: { ...write.command.data, username: 'different_payload' },
        },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const counts = await Promise.all([
      database
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('identity.account_state_history')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('identity.guest_preview_counters')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('identity.user_settings')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('billing.credit_accounts')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('notification.notification_preferences')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
      database
        .selectFrom('platform.audit_logs')
        .select('subject_id')
        .where('subject_id', '=', userId)
        .execute(),
      database
        .selectFrom('platform.outbox_events')
        .select('aggregate_id')
        .where('aggregate_id', '=', userId)
        .execute(),
      database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('scope', '=', 'identity.register-telegram-identity')
        .where('idempotency_key', '=', write.command.idempotencyKey)
        .execute(),
    ]);
    expect(counts.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 1]);
  });

  it('resolves simultaneous first starts to one User without orphan rows', async () => {
    const store = new PostgresIdentityStore(database);
    const handler = new RegisterTelegramIdentityHandler(
      store,
      { uuid: randomUUID },
      { now: () => new Date('2026-09-04T09:00:00.000Z') },
    );
    const telegramId = telegramUserId();
    const commands = Array.from(
      { length: 12 },
      (_, index) => registrationWrite(telegramId, index).command,
    );
    const beforeUsers = await database
      .selectFrom('identity.users')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    const results = await Promise.all(commands.map((item) => handler.execute(item)));
    const resolvedIds = new Set(results.map((result) => result.context.userId));
    expect(resolvedIds.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    const afterUsers = await database
      .selectFrom('identity.users')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(afterUsers.count) - Number(beforeUsers.count)).toBe(1);

    const userId = results[0]?.context.userId;
    expect(userId).toBeDefined();
    const aggregateCounts = await Promise.all([
      database
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', userId!)
        .execute(),
      database
        .selectFrom('identity.account_state_history')
        .select('user_id')
        .where('user_id', '=', userId!)
        .execute(),
      database
        .selectFrom('identity.guest_preview_counters')
        .select('user_id')
        .where('user_id', '=', userId!)
        .execute(),
      database
        .selectFrom('identity.user_settings')
        .select('user_id')
        .where('user_id', '=', userId!)
        .execute(),
      database
        .selectFrom('billing.credit_accounts')
        .select('user_id')
        .where('user_id', '=', userId!)
        .execute(),
      database
        .selectFrom('notification.notification_preferences')
        .select('user_id')
        .where('user_id', '=', userId!)
        .execute(),
    ]);
    expect(aggregateCounts.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('authorizes and serializes idempotent locale/visibility changes', async () => {
    const store = new PostgresIdentityStore(database);
    const userId = randomUUID();
    await store.registerTelegramIdentity(registrationWrite(telegramUserId(), 50, userId));
    await database
      .updateTable('identity.accounts')
      .set({
        state: 'active',
        state_reason: 'settings_integration_fixture',
        state_changed_at: new Date('2026-09-04T09:59:00.000Z'),
        version: 2,
      })
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    await expect(store.getByUserId(userId)).resolves.toMatchObject({
      userId,
      accountState: 'active',
      settingsVersion: 1,
    });

    const first = visibilityWrite(userId, 1, false, 1);
    await expect(store.changeSettings(first)).resolves.toMatchObject({
      visibilityEnabled: false,
      settingsVersion: 2,
      changed: true,
      replayed: false,
    });
    await expect(
      store.changeSettings({
        ...first,
        auditId: randomUUID(),
        eventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ settingsVersion: 2, changed: true, replayed: true });
    await expect(
      store.changeSettings({
        ...first,
        command: {
          ...first.command,
          data: { visibilityEnabled: true, expectedSettingsVersion: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(store.changeSettings(localeWrite(userId, 2, 'fa', 2))).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'error.settings.locale_inactive',
    });

    await database
      .updateTable('catalog.locales')
      .set({ is_active: true, updated_at: new Date('2026-09-04T10:01:00.000Z') })
      .where('code', '=', 'fa')
      .executeTakeFirstOrThrow();
    const concurrent = await Promise.allSettled([
      store.changeSettings(visibilityWrite(userId, 3, true, 2)),
      store.changeSettings(localeWrite(userId, 4, 'fa', 2)),
    ]);
    await database
      .updateTable('catalog.locales')
      .set({ is_active: false, updated_at: new Date('2026-09-04T10:02:00.000Z') })
      .where('code', '=', 'fa')
      .executeTakeFirstOrThrow();
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'version_conflict' } });

    const current = await store.getByUserId(userId);
    expect(current?.settingsVersion).toBe(3);
    const noOp = visibilityWrite(userId, 5, current?.visibilityEnabled ?? false, 3);
    await expect(store.changeSettings(noOp)).resolves.toMatchObject({
      settingsVersion: 3,
      changed: false,
      replayed: false,
    });

    const [settingAudits, settingEvents] = await Promise.all([
      database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', userId)
        .where('subject_type', '=', 'user_settings')
        .execute(),
      database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', userId)
        .where('event_type', 'in', ['identity.locale-changed.v1', 'identity.visibility-changed.v1'])
        .execute(),
    ]);
    expect(settingAudits).toHaveLength(2);
    expect(settingEvents).toHaveLength(2);
  });

  it('resumes a normalized signup draft and rejects stale concurrent writers', async () => {
    const identities = new PostgresIdentityStore(database);
    const signup = new PostgresSignupStore(database);
    const userId = randomUUID();
    await identities.registerTelegramIdentity(registrationWrite(telegramUserId(), 60, userId));

    const starts = await Promise.all([
      signup.startSignup(startSignupWrite(userId, 1)),
      signup.startSignup(startSignupWrite(userId, 2)),
    ]);
    expect(starts).toEqual([
      expect.objectContaining({ currentStep: 'age_confirmation', draftVersion: 1 }),
      expect.objectContaining({ currentStep: 'age_confirmation', draftVersion: 1 }),
    ]);

    const age = saveSignupWrite(userId, 1, 1, {
      step: 'age_confirmation',
      accepted: true,
    });
    const ageResult = await signup.saveSignupStep(age);
    await expect(
      signup.saveSignupStep({ ...age, auditId: randomUUID(), eventId: randomUUID() }),
    ).resolves.toEqual(ageResult);
    await expect(
      signup.saveSignupStep({
        ...age,
        command: { ...age.command, data: { ...age.command.data, expectedDraftVersion: 99 } },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const competingNames = await Promise.allSettled([
      signup.saveSignupStep(saveSignupWrite(userId, 2, 2, { step: 'name', value: '  Payam  ' })),
      signup.saveSignupStep(saveSignupWrite(userId, 3, 2, { step: 'name', value: 'Peyman' })),
    ]);
    expect(competingNames.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competingNames.find((result) => result.status === 'rejected')).toMatchObject({
      reason: {
        code: 'stale_signup_version',
        details: { currentStep: 'birth_year', currentVersion: '3' },
      },
    });

    const birth = saveSignupWrite(userId, 4, 3, { step: 'birth_year', value: '۲۰۰۰' });
    await signup.saveSignupStep(birth);
    await expect(
      signup.saveSignupStep(saveSignupWrite(userId, 5, 4, { step: 'gender', code: 'inactive' })),
    ).rejects.toMatchObject({ code: 'inactive_catalog_selection' });

    const remaining: Array<SaveSignupStepCommand['data']['value']> = [
      { step: 'gender', code: 'man' },
      { step: 'relationship_gender_preference', code: 'women' },
      { step: 'interests', codes: ['music', 'books', 'travel', 'coffee', 'art'] },
      { step: 'location', countryCode: 'iran', provinceCode: 'tehran', cityCode: 'tehran' },
      { step: 'relationship_goal', code: 'marriage' },
      { step: 'primary_photo', mediaAssetId: randomUUID() },
      { step: 'additional_photos', mediaAssetIds: [randomUUID()] },
      { step: 'highlight', value: '  Kind and curious  ' },
      {
        step: 'optional_details',
        value: {
          heightCm: 180,
          educationLevelCode: 'bachelor',
          languageCodes: ['persian', 'english'],
          personalityTagCodes: ['calm'],
        },
      },
    ];
    let version = 4;
    let index = 6;
    for (const value of remaining) {
      await signup.saveSignupStep(saveSignupWrite(userId, index, version, value));
      version += 1;
      index += 1;
    }

    const restartedStore = new PostgresSignupStore(database);
    await expect(restartedStore.getSignupState(userId)).resolves.toMatchObject({
      currentStep: 'confirm_profile',
      draftVersion: 13,
    });
    await expect(
      restartedStore.saveSignupStep(
        saveSignupWrite(userId, 15, 13, { step: 'confirm_profile', confirmed: true }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_signup_step' });

    const [account, draft, progress, startAudits, savedAudits, profiles] = await Promise.all([
      database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('identity.signup_drafts')
        .select(['draft_data', 'version'])
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('identity.signup_progress')
        .select('current_step')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', userId)
        .where('event_type', '=', 'identity.signup-started.v1')
        .execute(),
      database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', userId)
        .where('event_type', '=', 'identity.signup-step-saved.v1')
        .execute(),
      database.selectFrom('profile.profiles').select('id').where('user_id', '=', userId).execute(),
    ]);
    expect(account.state).toBe('incomplete');
    expect(progress.current_step).toBe('confirm_profile');
    expect(draft.version).toBe(13);
    expect(draft.draft_data).toMatchObject({
      birth_year: { step: 'birth_year', value: 2000 },
      highlight: { step: 'highlight', value: 'Kind and curious' },
    });
    expect(startAudits).toHaveLength(1);
    expect(savedAudits).toHaveLength(12);
    expect(profiles).toHaveLength(0);

    const [gender, preference, goal, country, province, wrongCity] = await Promise.all([
      database
        .selectFrom('catalog.gender_options')
        .select('id')
        .where('code', '=', 'man')
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('catalog.gender_preferences')
        .select('id')
        .where('code', '=', 'women')
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('catalog.relationship_goals')
        .select('id')
        .where('code', '=', 'marriage')
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('catalog.countries')
        .select('id')
        .where('code', '=', 'iran')
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('catalog.provinces')
        .select('id')
        .where('code', '=', 'tehran')
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('catalog.cities')
        .select('id')
        .where('code', '=', 'isfahan')
        .executeTakeFirstOrThrow(),
    ]);
    await expect(
      database
        .insertInto('profile.profiles')
        .values({
          id: randomUUID(),
          user_id: userId,
          name: 'Payam',
          birth_year: 2000,
          gender_option_id: gender.id,
          gender_preference_id: preference.id,
          relationship_goal_id: goal.id,
          country_id: country.id,
          province_id: province.id,
          city_id: wrongCity.id,
          highlight: 'Hello',
          bio: null,
          completion_status: 'incomplete',
          ever_completed: false,
          completed_at: null,
          random_shuffle_key: 0.5,
          version: 1,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow(/invalid profile location hierarchy/u);

    await database
      .updateTable('identity.signup_drafts')
      .set({ draft_data: { unknown_future_step: { step: 'unknown_future_step' } } })
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    await expect(restartedStore.getSignupState(userId)).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.signup.draft_invalid',
    });
  });

  it('confirms Profile atomically, replays duplicate confirmation, and edits safely', async () => {
    const identities = new PostgresIdentityStore(database);
    const signup = new PostgresSignupStore(database);
    const profiles = new PostgresProfileStore(database);
    const userId = randomUUID();
    await identities.registerTelegramIdentity(registrationWrite(telegramUserId(), 70, userId));
    await signup.startSignup(startSignupWrite(userId, 20));
    const primaryMediaAssetId = randomUUID();
    const additionalMediaAssetId = randomUUID();
    const values: Array<SaveSignupStepCommand['data']['value']> = [
      { step: 'age_confirmation', accepted: true },
      { step: 'name', value: 'Payam' },
      { step: 'birth_year', value: '۲۰۰۰' },
      { step: 'gender', code: 'man' },
      { step: 'relationship_gender_preference', code: 'women' },
      { step: 'interests', codes: ['music', 'books', 'travel', 'coffee', 'art'] },
      { step: 'location', countryCode: 'iran', provinceCode: 'tehran', cityCode: 'tehran' },
      { step: 'relationship_goal', code: 'marriage' },
      { step: 'primary_photo', mediaAssetId: primaryMediaAssetId },
      { step: 'additional_photos', mediaAssetIds: [additionalMediaAssetId] },
      { step: 'highlight', value: 'Kind and curious' },
      {
        step: 'optional_details',
        value: { languageCodes: ['persian'], personalityTagCodes: ['calm'] },
      },
    ];
    for (const [offset, value] of values.entries())
      await signup.saveSignupStep(saveSignupWrite(userId, 20 + offset, 1 + offset, value));

    const commandId = randomUUID();
    const command = {
      commandId,
      commandType: 'identity.confirm-signup' as const,
      schemaVersion: 1 as const,
      actor: { kind: 'user' as const, userId },
      requestId: randomUUID(),
      idempotencyKey: `confirm:${userId}`,
      occurredAt: '2026-09-04T12:00:00.000Z',
      locale: 'en',
      data: { expectedDraftVersion: 13 },
    };
    const processedAt = new Date('2026-09-04T12:00:01.000Z');
    const proof = {
      proofId: randomUUID(),
      userId,
      primaryMediaAssetId,
      acceptedMediaAssetIds: [primaryMediaAssetId, additionalMediaAssetId],
      issuedAt: new Date('2026-09-04T11:59:00.000Z'),
      expiresAt: new Date('2026-09-04T12:05:00.000Z'),
    };
    const makeWrite = (): ConfirmSignupWrite => ({
      command,
      proof,
      profileId: randomUUID(),
      accountHistoryId: randomUUID(),
      auditId: randomUUID(),
      profileEventId: randomUUID(),
      accountEventId: randomUUID(),
      processedAt,
    });
    await expect(
      profiles.confirmSignup({
        ...makeWrite(),
        command: { ...command, commandId: randomUUID(), idempotencyKey: `invalid-proof:${userId}` },
        proof: { ...proof, expiresAt: new Date('2026-09-04T11:00:00.000Z') },
      }),
    ).rejects.toMatchObject({ code: 'media_not_eligible' });
    const confirmations = await Promise.all([
      profiles.confirmSignup(makeWrite()),
      profiles.confirmSignup(makeWrite()),
    ]);
    expect(confirmations.map((result) => result.profile.profileId)).toEqual([
      confirmations[0].profile.profileId,
      confirmations[0].profile.profileId,
    ]);
    expect(confirmations.filter((result) => result.replayed)).toHaveLength(1);

    const updateCommand = {
      commandId: randomUUID(),
      commandType: 'profile.update' as const,
      schemaVersion: 1 as const,
      actor: { kind: 'user' as const, userId },
      requestId: randomUUID(),
      idempotencyKey: `profile-update:${userId}`,
      occurredAt: '2026-09-04T12:01:00.000Z',
      locale: 'en',
      data: {
        expectedProfileVersion: 1,
        patch: {
          name: '  Payám  ',
          interestCodes: ['music', 'books', 'travel', 'coffee', 'science'],
        },
      },
    };
    const updateWrite: UpdateProfileWrite = {
      command: updateCommand,
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date('2026-09-04T12:01:01.000Z'),
    };
    const updated = await profiles.updateOwnProfile(updateWrite);
    await expect(
      profiles.updateOwnProfile({ ...updateWrite, auditId: randomUUID(), eventId: randomUUID() }),
    ).resolves.toEqual(updated);
    expect(updated).toMatchObject({ name: 'Payám', completionStatus: 'complete', version: 2 });
    expect(updated.interestCodes).toEqual(['travel', 'music', 'books', 'coffee', 'science']);

    await database
      .updateTable('catalog.interests')
      .set({ is_active: false })
      .where('code', '=', 'science')
      .executeTakeFirstOrThrow();
    const invalidateCommand = {
      ...updateCommand,
      commandId: randomUUID(),
      idempotencyKey: `profile-invalidate:${userId}`,
      data: { expectedProfileVersion: 2, patch: { name: 'Payam' } },
    };
    const invalid = await profiles.updateOwnProfile({
      command: invalidateCommand,
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date('2026-09-04T12:02:00.000Z'),
    });
    expect(invalid.completionStatus).toBe('invalid');
    await database
      .updateTable('catalog.interests')
      .set({ is_active: true })
      .where('code', '=', 'science')
      .executeTakeFirstOrThrow();
    const restoreCommand = {
      ...updateCommand,
      commandId: randomUUID(),
      idempotencyKey: `profile-restore:${userId}`,
      data: { expectedProfileVersion: 3, patch: { name: 'Payam' } },
    };
    await expect(
      profiles.updateOwnProfile({
        command: restoreCommand,
        auditId: randomUUID(),
        eventId: randomUUID(),
        processedAt: new Date('2026-09-04T12:03:00.000Z'),
      }),
    ).resolves.toMatchObject({ completionStatus: 'complete', version: 4 });

    const [account, progress, profileRows, histories, confirmationAudits, confirmationEvents] =
      await Promise.all([
        database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('identity.signup_progress')
          .select(['current_step', 'completed_at'])
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('profile.profiles')
          .select('id')
          .where('user_id', '=', userId)
          .execute(),
        database
          .selectFrom('identity.account_state_history')
          .select('id')
          .where('user_id', '=', userId)
          .where('next_state', '=', 'active')
          .execute(),
        database
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('subject_id', '=', confirmations[0].profile.profileId)
          .where('event_type', '=', 'profile.confirmed.v1')
          .execute(),
        database
          .selectFrom('platform.outbox_events')
          .select('id')
          .where('aggregate_id', '=', confirmations[0].profile.profileId)
          .where('event_type', '=', 'profile.confirmed.v1')
          .execute(),
      ]);
    expect(account.state).toBe('active');
    expect(progress.current_step).toBe('completed');
    expect(progress.completed_at).not.toBeNull();
    expect(profileRows).toHaveLength(1);
    expect(histories).toHaveLength(1);
    expect(confirmationAudits).toHaveLength(1);
    expect(confirmationEvents).toHaveLength(1);

    const protectedChanges = new PostgresProfileChangeStore(database);
    const changeCommand: RequestProtectedProfileChangeCommand = {
      commandId: randomUUID(),
      commandType: 'profile.request-protected-change',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `profile-change-gender:${userId}`,
      occurredAt: '2026-09-04T12:04:00.000Z',
      locale: 'en',
      data: {
        field: 'gender',
        requestedValue: 'woman',
        reason: 'Correction',
        expectedProfileVersion: 4,
      },
    };
    const makeChangeWrite = (): RequestProtectedProfileChangeWrite => ({
      command: changeCommand,
      normalized: { field: 'gender', requestedValue: 'woman', reason: 'Correction' },
      profileChangeRequestId: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date('2026-09-04T12:04:01.000Z'),
    });
    const submitted = await Promise.all([
      protectedChanges.requestProtectedChange(makeChangeWrite()),
      protectedChanges.requestProtectedChange(makeChangeWrite()),
    ]);
    expect(submitted.filter((result) => result.replayed)).toHaveLength(1);
    expect(submitted[0].request.requestId).toBe(submitted[1].request.requestId);
    await expect(
      protectedChanges.requestProtectedChange({
        ...makeChangeWrite(),
        command: {
          ...changeCommand,
          commandId: randomUUID(),
          idempotencyKey: `profile-change-gender-competing:${userId}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'pending_profile_change_exists' });

    const reviewerUserId = randomUUID();
    const reviewerTelegramId = telegramUserId();
    await identities.registerTelegramIdentity(
      registrationWrite(reviewerTelegramId, 71, reviewerUserId),
    );
    const adminUserId = randomUUID();
    await database
      .insertInto('administration.admin_users')
      .values({
        id: adminUserId,
        user_id: reviewerUserId,
        telegram_user_id: reviewerTelegramId,
        is_active: true,
        disabled_at: null,
        created_at: new Date('2026-09-04T12:04:30.000Z'),
        updated_at: new Date('2026-09-04T12:04:30.000Z'),
      })
      .executeTakeFirstOrThrow();
    const resolveCommand: ResolveProtectedProfileChangeCommand = {
      commandId: randomUUID(),
      commandType: 'profile.resolve-protected-change',
      schemaVersion: 1,
      actor: { kind: 'admin', userId: reviewerUserId },
      requestId: randomUUID(),
      idempotencyKey: `profile-change-resolve:${submitted[0].request.requestId}`,
      occurredAt: '2026-09-04T12:05:00.000Z',
      locale: 'en',
      channelContext: { channel: 'internal' },
      data: {
        profileChangeRequestId: submitted[0].request.requestId,
        decision: 'approved',
        note: 'Verified correction',
      },
    };
    const makeResolveWrite = (): ResolveProtectedProfileChangeWrite => ({
      command: resolveCommand,
      authorization: { adminUserId, reviewerUserId },
      normalizedNote: 'Verified correction',
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date('2026-09-04T12:05:01.000Z'),
    });
    const resolved = await Promise.all([
      protectedChanges.resolveProtectedChange(makeResolveWrite()),
      protectedChanges.resolveProtectedChange(makeResolveWrite()),
    ]);
    expect(resolved.filter((result) => result.replayed)).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decision: 'approved', profileVersion: 5 });
    await expect(
      protectedChanges.resolveProtectedChange({
        ...makeResolveWrite(),
        command: {
          ...resolveCommand,
          commandId: randomUUID(),
          idempotencyKey: `profile-change-reverse:${submitted[0].request.requestId}`,
          data: { ...resolveCommand.data, decision: 'rejected' },
        },
      }),
    ).rejects.toMatchObject({ code: 'profile_change_invalid' });

    const birthCommand: RequestProtectedProfileChangeCommand = {
      ...changeCommand,
      commandId: randomUUID(),
      idempotencyKey: `profile-change-birth:${userId}`,
      data: {
        field: 'birth_year',
        requestedValue: 1999,
        reason: 'Correction',
        expectedProfileVersion: 5,
      },
    };
    const birthRequest = await protectedChanges.requestProtectedChange({
      command: birthCommand,
      normalized: { field: 'birth_year', requestedValue: 1999, reason: 'Correction' },
      profileChangeRequestId: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date('2026-09-04T12:06:00.000Z'),
    });
    const competingDecisions = await Promise.allSettled(
      (['approved', 'rejected'] as const).map((decision, index) =>
        protectedChanges.resolveProtectedChange({
          command: {
            ...resolveCommand,
            commandId: randomUUID(),
            idempotencyKey: `profile-change-birth-decision:${index}:${birthRequest.request.requestId}`,
            data: { profileChangeRequestId: birthRequest.request.requestId, decision },
          },
          authorization: { adminUserId, reviewerUserId },
          normalizedNote: undefined,
          auditId: randomUUID(),
          eventId: randomUUID(),
          processedAt: new Date(`2026-09-04T12:06:0${index + 1}.000Z`),
        }),
      ),
    );
    expect(competingDecisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competingDecisions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const finalBirthRequest = await protectedChanges.getProtectedChangeRequest(
      userId,
      birthRequest.request.requestId,
    );
    expect(finalBirthRequest?.status).toMatch(/^(approved|rejected)$/u);
    await expect(
      protectedChanges.getProtectedChangeRequest(reviewerUserId, birthRequest.request.requestId),
    ).resolves.toBeUndefined();
    const [protectedProfile, reviews, requestAudits, requestEvents] = await Promise.all([
      profiles.getOwnProfile(userId),
      database
        .selectFrom('profile.profile_change_reviews')
        .select('request_id')
        .where('request_id', 'in', [submitted[0].request.requestId, birthRequest.request.requestId])
        .execute(),
      database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', submitted[0].request.requestId)
        .execute(),
      database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', submitted[0].request.requestId)
        .execute(),
    ]);
    expect(protectedProfile?.genderCode).toBe('woman');
    expect(protectedProfile?.birthYear).toBe(
      finalBirthRequest?.status === 'approved' ? 1999 : 2000,
    );
    expect(protectedProfile?.version).toBe(finalBirthRequest?.status === 'approved' ? 6 : 5);
    expect(reviews).toHaveLength(2);
    expect(requestAudits).toHaveLength(2);
    expect(requestEvents).toHaveLength(2);
    await expect(
      database
        .updateTable('profile.profile_change_reviews')
        .set({ admin_note: 'mutated' })
        .where('request_id', '=', submitted[0].request.requestId)
        .execute(),
    ).rejects.toThrow(/append-only/u);
  });

  it('enforces append-only history and the immutable Guest Preview limit snapshot', async () => {
    const identity = await database
      .selectFrom('identity.telegram_identities')
      .select('user_id')
      .orderBy('first_seen_at', 'desc')
      .executeTakeFirstOrThrow();
    await expect(
      database
        .updateTable('identity.account_state_history')
        .set({ reason_code: 'tampered' })
        .where('user_id', '=', identity.user_id)
        .execute(),
    ).rejects.toThrow(/append-only/u);
    await expect(
      database
        .updateTable('identity.guest_preview_counters')
        .set({ limit_count: 11 })
        .where('user_id', '=', identity.user_id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      database
        .updateTable('platform.audit_logs')
        .set({ result_code: 'tampered' })
        .where('subject_id', '=', identity.user_id)
        .execute(),
    ).rejects.toThrow(/append-only/u);
  });
});
