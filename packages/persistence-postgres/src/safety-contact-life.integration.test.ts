import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BanOpaqueReferences,
  OpenSupportThreadHandler,
  PrepareAppealHandler,
  SubmitAppealHandler,
  SupportOpaqueReferences,
  type OpaqueTokenStore,
  type UserAppealWrite,
} from '@nakh/application';
import type { OpenSupportThreadCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresAppealStore } from './appeal-store.js';
import { PostgresSupportStore } from './support-store.js';
import { PostgresSafetyContactStore } from './safety-contact-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
function tokens(): OpaqueTokenStore {
  const values = new Map<string, string>();
  return {
    get: (id) => Promise.resolve(values.get(id)),
    putIfAbsent: (id, value) => {
      if (values.has(id)) return Promise.resolve(false);
      values.set(id, value);
      return Promise.resolve(true);
    },
  };
}
function openCommand(userId: string): OpenSupportThreadCommand {
  const commandId = randomUUID();
  return {
    commandId,
    commandType: 'support.open-thread',
    schemaVersion: 1,
    actor: { kind: 'user', userId },
    requestId: commandId,
    idempotencyKey: commandId,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { text: 'Synthetic help text' },
  };
}
function appealWrite(userId: string, banHistoryId: string): UserAppealWrite {
  const commandId = randomUUID();
  return {
    userId,
    banHistoryId,
    expectedProductEpoch: 0,
    commandId,
    appealId: randomUUID(),
    eventId: randomUUID(),
    requestId: commandId,
    idempotencyKey: commandId,
    requestDigest: createHash('sha256').update(commandId).digest('hex'),
    normalizedText: 'Synthetic appeal text',
  };
}
describe.skipIf(url === undefined)('M8 original-life safety contact', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_safety_life');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  function support(userId: string, productEpoch = 0): OpenSupportThreadHandler {
    return new OpenSupportThreadHandler(
      new PostgresSupportStore(database),
      SupportOpaqueReferences.forLife(tokens(), Buffer.alloc(32, 17), { userId, productEpoch }),
      { uuid: randomUUID },
    );
  }
  async function ban(userId: string): Promise<string> {
    const id = randomUUID();
    await database.transaction().execute(async (tx) => {
      const account = await tx
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const at = new Date(Math.max(Date.now(), account.state_changed_at.getTime() + 1));
      await tx
        .updateTable('identity.accounts')
        .set({
          state: 'banned',
          state_reason: 'synthetic_ban',
          state_changed_at: at,
          version: account.version + 1,
        })
        .where('user_id', '=', userId)
        .execute();
      await tx
        .insertInto('identity.account_state_history')
        .values({
          id,
          user_id: userId,
          previous_state: account.state,
          next_state: 'banned',
          reason_code: 'synthetic_ban',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          changed_at: at,
        })
        .execute();
    });
    return id;
  }
  // Privileged corruption fixture only; this never proves approved native Return.
  async function changeEpoch(tx: NakhDatabase, userId: string): Promise<void> {
    await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
    try {
      await tx
        .updateTable('identity.accounts')
        .set({ product_epoch: 1 })
        .where('user_id', '=', userId)
        .execute();
    } finally {
      await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
    }
  }
  it('rejects mismatched and malformed captured lives without routing or allocating support', async () => {
    const userId = await createReportUser(database),
      command = openCommand(userId);
    for (const epoch of [1, -1, NaN, 0.5]) {
      expect(await new PostgresSafetyContactStore(database).get(userId, epoch)).toEqual({
        route: 'unavailable',
      });
      expect(await new PostgresAppealStore(database).currentBan(userId, epoch)).toBeUndefined();
      await expect(support(userId).execute(command, epoch)).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    await expect(
      new PostgresAppealStore(database).submit(appealWrite(randomUUID(), randomUUID())),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await database
        .selectFrom('support.support_threads')
        .select('id')
        .where('user_id', '=', userId)
        .execute(),
    ).toEqual([]);
  });
  it('converges twenty support retries to one original-life thread and stable opaque reference', async () => {
    const userId = await createReportUser(database),
      command = openCommand(userId),
      handler = support(userId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => handler.execute(command, 0)),
    );
    expect(new Set(results.map((result) => result.supportThreadId)).size).toBe(1);
    expect(new Set(results.map((result) => result.supportActionToken)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const row = await database
      .selectFrom('support.support_threads')
      .select(['id', 'product_epoch'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.product_epoch).toBe(0);
    expect(
      await database
        .selectFrom('support.support_messages')
        .select('id')
        .where('support_thread_id', '=', row.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', row.id)
        .execute(),
    ).toHaveLength(1);
  });
  it('denies old support replay and cross-life send while keeping new-life quota independent', async () => {
    const userId = await createReportUser(database),
      command = openCommand(userId),
      handler = support(userId);
    const original = await handler.execute(command, 0);
    await database.transaction().execute((tx) => changeEpoch(tx, userId));
    await expect(handler.execute(command, 0)).rejects.toMatchObject({ code: 'conflict' });
    const current = await support(userId, 1).execute(openCommand(userId), 1);
    expect(current.unansweredUserMessages).toBe(1);
    expect(current.supportThreadId).not.toBe(original.supportThreadId);
    await expect(
      new PostgresSupportStore(database).send({
        userId,
        expectedProductEpoch: 1,
        supportThreadId: original.supportThreadId,
        messageId: randomUUID(),
        eventId: randomUUID(),
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestDigest: 'f'.repeat(64),
        normalizedText: 'Synthetic old-thread attempt',
        expectedVersion: original.version,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await database
        .selectFrom('support.support_messages')
        .select('id')
        .where('support_thread_id', '=', original.supportThreadId)
        .execute(),
    ).toHaveLength(1);
  });
  it('preserves one exact-ban appeal across twenty captured-life submissions', async () => {
    const userId = await createReportUser(database),
      banId = await ban(userId);
    const store = new PostgresAppealStore(database),
      refs = BanOpaqueReferences.forLife(tokens(), Buffer.alloc(32, 18), {
        userId,
        productEpoch: 0,
      });
    const commandId = randomUUID(),
      token = await new PrepareAppealHandler(store, refs).execute(userId, commandId, 0);
    const handler = new SubmitAppealHandler(store, refs, { uuid: randomUUID });
    const command = {
      commandId,
      commandType: 'moderation.submit-appeal' as const,
      schemaVersion: 1 as const,
      actor: { kind: 'user' as const, userId },
      requestId: commandId,
      idempotencyKey: commandId,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { text: 'Synthetic appeal text', banActionToken: token },
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => handler.execute(command, 0)),
    );
    expect(new Set(results.map((result) => result.appealId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.user_appeals')
        .select('id')
        .where('ban_state_history_id', '=', banId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'banned' });
  });
  it('denies stale appeal preparation and completed replay before observing retained results', async () => {
    const userId = await createReportUser(database),
      banId = await ban(userId),
      input = appealWrite(userId, banId),
      store = new PostgresAppealStore(database);
    const original = await store.submit(input);
    await database.transaction().execute((tx) => changeEpoch(tx, userId));
    expect(await store.currentBan(userId, 0)).toBeUndefined();
    expect(await new PostgresSafetyContactStore(database).get(userId, 0)).toEqual({
      route: 'unavailable',
    });
    await expect(store.submit(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await database
        .selectFrom('moderation.user_appeals')
        .select(['id', 'ban_state_history_id'])
        .where('user_id', '=', userId)
        .execute(),
    ).toEqual([{ id: original.appealId, ban_state_history_id: banId }]);
  });
  it.each(['support', 'appeal'] as const)(
    'rechecks %s life after waiting for the stable User lock',
    async (kind) => {
      const userId = await createReportUser(database),
        banId = kind === 'appeal' ? await ban(userId) : undefined;
      let release!: () => void, acquired!: (pid: number) => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<number>((resolve) => {
        acquired = resolve;
      });
      const blocker = database.transaction().execute(async (tx) => {
        await tx
          .selectFrom('identity.users')
          .select('id')
          .where('id', '=', userId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        acquired(
          (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!.pid,
        );
        await waiting;
        await changeEpoch(tx, userId);
      });
      const pid = await locked;
      const operation =
        kind === 'support'
          ? support(userId).execute(openCommand(userId), 0)
          : new PostgresAppealStore(database).submit(appealWrite(userId, banId!));
      const pending = operation.then(
        () => undefined,
        (error) => error as unknown,
      );
      let blocked = false;
      try {
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = (
            await sql<{
              blocked: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid}::integer=ANY(pg_blocking_pids(pid))) AS blocked`.execute(database)
          ).rows[0]!.blocked;
          if (!blocked) await setTimeout(20);
        }
      } finally {
        release();
        await blocker;
      }
      expect(blocked).toBe(true);
      expect(await pending).toMatchObject({ code: 'conflict' });
      expect(
        await database
          .selectFrom('support.support_threads')
          .select('id')
          .where('user_id', '=', userId)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('moderation.user_appeals')
          .select('id')
          .where('user_id', '=', userId)
          .execute(),
      ).toEqual([]);
    },
  );
  it('blocks completed appeal replay after an actual banned-account tombstone while preserving safety proof', async () => {
    let input!: UserAppealWrite;
    const { userId } = await createDeletionFixture(database, async (subject) => {
      input = appealWrite(subject, await ban(subject));
      await new PostgresAppealStore(database).submit(input);
    });
    await expect(new PostgresAppealStore(database).submit(input)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await new PostgresSafetyContactStore(database).get(userId, 0)).toEqual({
      route: 'unavailable',
    });
    expect(
      await database
        .selectFrom('moderation.user_appeals')
        .select('message_text')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ message_text: input.normalizedText });
    expect(
      await database
        .selectFrom('identity.account_state_history')
        .select('id')
        .where('id', '=', input.banHistoryId)
        .execute(),
    ).toHaveLength(1);
  });
});
