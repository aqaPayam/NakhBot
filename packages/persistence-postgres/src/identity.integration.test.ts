import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresIdentityStore, PostgresLocalizationStore } from './identity-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

function telegramUserId(): string {
  return String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000));
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
    expect(Object.keys(english.messages)).toHaveLength(18);
    expect(english.messages['start.guest.title']).toBe('Welcome to Nakh');
    expect(inactiveFallback).toMatchObject({ requestedLocale: 'fa', resolvedLocale: 'en' });
  });

  it('creates the entire first-start aggregate atomically', async () => {
    const store = new PostgresIdentityStore(database);
    const userId = randomUUID();
    const result = await store.registerOrResolveTelegramIdentity({
      userId,
      accountHistoryId: randomUUID(),
      telegramUserId: telegramUserId(),
      username: 'first_user',
      occurredAt: new Date('2026-09-04T08:00:00.000Z'),
      guestPreviewLimit: 10,
      defaultLocale: 'en',
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
    ]);
    expect(counts.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('resolves simultaneous first starts to one User without orphan rows', async () => {
    const store = new PostgresIdentityStore(database);
    const telegramId = telegramUserId();
    const attempts = Array.from({ length: 12 }, (_, index) => ({
      userId: randomUUID(),
      accountHistoryId: randomUUID(),
      telegramUserId: telegramId,
      username: `race_${index}`,
      occurredAt: new Date('2026-09-04T09:00:00.000Z'),
      guestPreviewLimit: 10,
      defaultLocale: 'en',
    }));
    const beforeUsers = await database
      .selectFrom('identity.users')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    const results = await Promise.all(
      attempts.map((attempt) => store.registerOrResolveTelegramIdentity(attempt)),
    );
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
  });
});
