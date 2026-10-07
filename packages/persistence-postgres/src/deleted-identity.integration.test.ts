import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { RegisterTelegramIdentityWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresIdentityStore } from './identity-store.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
function start(telegramId: string, userId = randomUUID()): RegisterTelegramIdentityWrite {
  const commandId = randomUUID();
  const at = new Date();
  return {
    command: {
      commandId,
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
      requestId: randomUUID(),
      idempotencyKey: `m8-start:${commandId}`,
      occurredAt: at.toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: telegramId },
      data: { telegramUserId: telegramId, updateId: commandId, username: 'mutable_name' },
    },
    userId,
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    registrationEventId: randomUUID(),
    startRouteEventId: randomUUID(),
    processedAt: at,
    guestPreviewLimit: 10,
    defaultLocale: 'en',
  };
}

describe.skipIf(databaseUrl === undefined)('M8 deleted identity isolation', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(databaseUrl!, 'nakh_m8_deleted_identity');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });

  async function deletedFixture(): Promise<RegisterTelegramIdentityWrite> {
    const write = start(String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)));
    await new PostgresIdentityStore(database).registerTelegramIdentity(write);
    await database
      .updateTable('identity.accounts')
      .set({ state: 'deleted', version: 2 })
      .where('user_id', '=', write.userId)
      .execute();
    await database
      .updateTable('identity.guest_preview_counters')
      .set({
        preview_count: 7,
        first_preview_at: write.processedAt,
        last_preview_at: write.processedAt,
      })
      .where('user_id', '=', write.userId)
      .execute();
    await database
      .deleteFrom('identity.user_settings')
      .where('user_id', '=', write.userId)
      .execute();
    return write;
  }

  it('resolves the retained identity after preference purge without restoring product settings', async () => {
    const write = await deletedFixture();
    const store = new PostgresIdentityStore(database);
    const expected = {
      userId: write.userId,
      accountState: 'deleted',
      entryRoute: 'return_decision',
      visibilityEnabled: false,
      uiLocale: 'en',
      settingsVersion: 0,
      accountVersion: 2,
      guestPreviewCount: 7,
      guestPreviewLimit: 10,
    };
    await expect(store.getByUserId(write.userId)).resolves.toMatchObject(expected);
    await expect(
      store.getByTelegramUserId(write.command.data.telegramUserId),
    ).resolves.toMatchObject(expected);
    await expect(
      store.registerTelegramIdentity(start(write.command.data.telegramUserId)),
    ).resolves.toMatchObject({
      created: false,
      context: expected,
    });
    expect(
      await database
        .selectFrom('identity.user_settings')
        .selectAll()
        .where('user_id', '=', write.userId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select('username')
        .where('user_id', '=', write.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ username: null });
  });

  it('rechecks live account state instead of replaying a previous guest context', async () => {
    const write = await deletedFixture();
    await expect(
      new PostgresIdentityStore(database).registerTelegramIdentity(write),
    ).resolves.toMatchObject({
      replayed: true,
      context: {
        accountState: 'deleted',
        entryRoute: 'return_decision',
        settingsVersion: 0,
        guestPreviewCount: 7,
      },
    });
  });

  it('serializes twenty new starts without a duplicate identity, reset counter or revived username', async () => {
    const write = await deletedFixture();
    const store = new PostgresIdentityStore(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.registerTelegramIdentity(start(write.command.data.telegramUserId)),
      ),
    );
    for (const result of results)
      expect(result).toMatchObject({
        created: false,
        context: { userId: write.userId, accountState: 'deleted', guestPreviewCount: 7 },
      });
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select(['user_id', 'username'])
        .where('telegram_user_id', '=', write.command.data.telegramUserId)
        .execute(),
    ).toEqual([{ user_id: write.userId, username: null }]);
    expect(
      await database
        .selectFrom('identity.guest_preview_counters')
        .select('preview_count')
        .where('user_id', '=', write.userId)
        .execute(),
    ).toEqual([{ preview_count: 7 }]);
  });

  it('uses default routing even before old settings have been purged', async () => {
    const write = start(String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)));
    const store = new PostgresIdentityStore(database);
    await store.registerTelegramIdentity(write);
    await database
      .updateTable('identity.user_settings')
      .set({ ui_locale_code: 'fa' })
      .where('user_id', '=', write.userId)
      .execute();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'deleted', version: 2 })
      .where('user_id', '=', write.userId)
      .execute();
    await expect(store.getByUserId(write.userId)).resolves.toMatchObject({
      uiLocale: 'en',
      visibilityEnabled: false,
      settingsVersion: 0,
    });
  });

  it('rechecks a tombstone committed while a start waits for the account mutation locks', async () => {
    const write = start(String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)));
    const store = new PostgresIdentityStore(database);
    await store.registerTelegramIdentity(write);
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolveLocked) => {
      signalLocked = resolveLocked;
    });
    const released = new Promise<void>((resolveReleased) => {
      release = resolveReleased;
    });
    const tombstone = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', write.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', write.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('identity.accounts')
        .set({ state: 'deleted', version: 2 })
        .where('user_id', '=', write.userId)
        .execute();
      await transaction
        .updateTable('identity.telegram_identities')
        .set({ username: null })
        .where('user_id', '=', write.userId)
        .execute();
      signalLocked();
      await released;
    });
    await locked;
    const starts = Promise.all(
      Array.from({ length: 20 }, () =>
        store.registerTelegramIdentity(start(write.command.data.telegramUserId)),
      ),
    );
    let observedWait = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const waiting = await sql<{ waiting: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%"identity"."users"%'
        ) AS waiting`.execute(database);
        if (waiting.rows[0]?.waiting === true) {
          observedWait = true;
          break;
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
    } finally {
      release();
    }
    await tombstone;
    const results = await starts;
    expect(observedWait).toBe(true);
    for (const result of results)
      expect(result).toMatchObject({
        context: { accountState: 'deleted', entryRoute: 'return_decision' },
      });
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select('username')
        .where('user_id', '=', write.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ username: null });
  });

  it('fails closed for a live account with missing settings instead of registering a second identity', async () => {
    const write = start(String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)));
    const store = new PostgresIdentityStore(database);
    await store.registerTelegramIdentity(write);
    await database
      .deleteFrom('identity.user_settings')
      .where('user_id', '=', write.userId)
      .execute();
    await expect(
      store.registerTelegramIdentity(start(write.command.data.telegramUserId)),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await database
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('telegram_user_id', '=', write.command.data.telegramUserId)
        .execute(),
    ).toHaveLength(1);
  });
});
