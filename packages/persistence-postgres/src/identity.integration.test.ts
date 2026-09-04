import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RegisterTelegramIdentityHandler,
  type RegisterTelegramIdentityWrite,
} from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresIdentityStore, PostgresLocalizationStore } from './identity-store.js';
import { runMigrations } from './migrations.js';

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
    expect(Object.keys(english.messages)).toHaveLength(25);
    expect(english.messages['start.guest.title']).toBe('Welcome to Nakh');
    expect(inactiveFallback).toMatchObject({ requestedLocale: 'fa', resolvedLocale: 'en' });
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
