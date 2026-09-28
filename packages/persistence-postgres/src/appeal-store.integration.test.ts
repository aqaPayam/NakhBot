import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BanOpaqueReferences,
  OpenSupportThreadHandler,
  PrepareAppealHandler,
  SubmitAppealHandler,
  SupportOpaqueReferences,
  UserSafetyContactHandler,
  type UserAppealWrite,
  type OpaqueTokenStore,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresAppealStore } from './appeal-store.js';
import { PostgresSafetyContactStore } from './safety-contact-store.js';
import { PostgresSupportStore } from './support-store.js';
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
  it('composes authenticated contact handlers with transactional replay and changed-payload rejection', async () => {
    const values = new Map<string, string>();
    const tokens: OpaqueTokenStore = {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    };
    const refs = new BanOpaqueReferences(tokens, Buffer.alloc(32, 7));
    const ids = { uuid: randomUUID };
    const handler = new UserSafetyContactHandler(
      new PostgresSafetyContactStore(database),
      new OpenSupportThreadHandler(
        new PostgresSupportStore(database),
        new SupportOpaqueReferences(tokens, Buffer.alloc(32, 7)),
        ids,
      ),
      new PrepareAppealHandler(store, refs),
      new SubmitAppealHandler(store, refs, ids),
    );
    const userId = await createUser(database);
    await ban(database, userId);
    const input = {
      userId,
      commandId: randomUUID(),
      kind: 'appeal' as const,
      text: 'Restricted explanation',
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => handler.execute(input)));
    expect(results).toEqual(
      Array.from({ length: 6 }, () => ({ key: 'appeal.submitted', variables: {} })),
    );
    const rows = await database
      .selectFrom('moderation.user_appeals')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(1);
    await expect(handler.execute({ ...input, text: 'Changed explanation' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(handler.execute({ ...input, kind: 'support' })).resolves.toEqual({
      key: 'appeal.prompt',
      variables: {},
    });
    const threads = await database
      .selectFrom('support.support_threads')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(threads).toHaveLength(0);
  });
  it('projects only the exact current ban status and routes missing/deleted accounts nowhere', async () => {
    const states = new PostgresSafetyContactStore(database);
    expect(await states.get(randomUUID())).toEqual({ route: 'unavailable' });
    const userId = await createUser(database);
    expect(await states.get(userId)).toEqual({ route: 'support' });
    const historyId = await ban(database, userId);
    expect(await states.get(userId)).toEqual({ route: 'appeal' });
    const submitted = write(userId, historyId);
    await store.submit(submitted);
    expect(await states.get(userId)).toEqual({ route: 'appeal', status: 'submitted' });
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active' })
      .where('user_id', '=', userId)
      .execute();
    expect(await states.get(userId)).toEqual({ route: 'support' });
    await ban(database, userId);
    expect(await states.get(userId)).toEqual({ route: 'appeal' });
    await database
      .updateTable('identity.accounts')
      .set({ state: 'deleted' })
      .where('user_id', '=', userId)
      .execute();
    expect(await states.get(userId)).toEqual({ route: 'unavailable' });
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
