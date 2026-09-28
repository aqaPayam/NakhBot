import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserAppealWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresAppealStore } from './appeal-store.js';
const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
async function createUser(
  database: NakhDatabase,
  state: 'active' | 'banned' = 'active',
): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({
      user_id: userId,
      state,
      state_reason: state === 'banned' ? 'test_ban' : null,
      state_changed_at: now,
    })
    .execute();
  return userId;
}

async function ban(database: NakhDatabase, userId: string): Promise<string> {
  const id = randomUUID();
  await database.transaction().execute(async (tx) => {
    const account = await tx
      .selectFrom('identity.accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = new Date(Math.max(Date.now(), account.state_changed_at.getTime() + 1));
    await tx
      .updateTable('identity.accounts')
      .set({
        state: 'banned',
        state_reason: 'test_ban',
        state_changed_at: now,
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
        reason_code: 'test_ban',
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        changed_at: now,
      })
      .execute();
  });
  return id;
}
function write(userId: string, banHistoryId: string): UserAppealWrite {
  const commandId = randomUUID();
  return {
    userId,
    banHistoryId,
    commandId,
    appealId: randomUUID(),
    eventId: randomUUID(),
    requestId: randomUUID(),
    idempotencyKey: commandId,
    requestDigest: createHash('sha256').update(commandId).digest('hex'),
    normalizedText: 'Restricted appeal text',
  };
}
describe.skipIf(databaseUrl === undefined)('M7 exact-ban appeal admission', () => {
  let database: NakhDatabase;
  let store: PostgresAppealStore;
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
    store = new PostgresAppealStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('serializes independent concurrent submissions into one appeal and one content-free event', async () => {
    const userId = await createUser(database);
    const historyId = await ban(database, userId);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes = Array.from({ length: 12 }, () => write(userId, historyId));
    const racers = writes.map(async (input) => {
      await barrier;
      return store.submit(input);
    });
    release();
    const outcomes = await Promise.allSettled(racers);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const appeals = await database
      .selectFrom('moderation.user_appeals')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(appeals).toHaveLength(1);
    const winner = writes.find((input) => input.appealId === appeals[0]!.id)!;
    await expect(
      store.submit({ ...winner, appealId: randomUUID(), eventId: randomUUID() }),
    ).resolves.toMatchObject({ appealId: winner.appealId, replayed: true });
    await expect(store.submit({ ...winner, requestDigest: 'a'.repeat(64) })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_id', '=', winner.appealId)
      .execute();
    expect(events).toEqual([
      { payload: { appealId: winner.appealId, status: 'submitted', version: 1 } },
    ]);
    await expect(
      database.deleteFrom('moderation.user_appeals').where('id', '=', winner.appealId).execute(),
    ).rejects.toThrow();
  });
  it('rejects forged, foreign, stale and non-banned events in application and database', async () => {
    const userId = await createUser(database),
      other = await createUser(database);
    const historyId = await ban(database, userId);
    expect(await store.currentBan(userId)).toBe(historyId);
    await expect(store.submit(write(other, historyId))).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.submit(write(userId, randomUUID()))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      database
        .insertInto('moderation.user_appeals')
        .values({
          id: randomUUID(),
          user_id: other,
          ban_state_history_id: historyId,
          message_text: 'test',
          reviewed_by_admin_id: null,
          admin_note: null,
          reviewed_at: null,
        })
        .execute(),
    ).rejects.toThrow();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active', state_reason: null })
      .where('user_id', '=', userId)
      .execute();
    await expect(store.submit(write(userId, historyId))).rejects.toMatchObject({
      code: 'conflict',
    });
    const newHistory = await ban(database, userId);
    await expect(store.submit(write(userId, historyId))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(store.submit(write(userId, newHistory))).resolves.toMatchObject({
      status: 'submitted',
    });
  });
});
