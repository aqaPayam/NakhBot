import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SendPredefinedChatMessageWrite, UserSessionActor } from '@nakh/application';
import type { SendPredefinedQuestionCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresChatStore } from './chat-store.js';
import { PostgresChatStateStore } from './chat-state-store.js';
import { PostgresUnmatchStore } from './unmatch-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionNoticeStore } from './account-deletion-notice-store.js';
import { PostgresAccountDeletionPairStore } from './account-deletion-pair-store.js';
import { lockUserPair } from './pair-lock.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportChat, createReportUser } from './testing/report-fixture.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const reference = `v1.ch.${'a'.repeat(22)}.${'b'.repeat(22)}`;
describe.skipIf(url === undefined)('captured native chat user grants', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_chat_grants');
    await runMigrations(isolated.url, resolve('migrations'));
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
  async function actor(userId: string): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (grant === undefined) throw new Error('Native chat fixture grant unavailable');
    return { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
  }
  async function conversation(first?: string): Promise<{
    first: UserSessionActor;
    second: UserSessionActor;
    matchId: string;
    chatSessionId: string;
  }> {
    const firstId = first ?? (await createReportUser(database, true)),
      secondId = await createReportUser(database, true);
    const now = new Date();
    for (const userId of [firstId, secondId]) {
      await database
        .insertInto('identity.user_settings')
        .values({ user_id: userId, visibility_enabled: true, created_at: now, updated_at: now })
        .onConflict((c) => c.column('user_id').doNothing())
        .execute();
      await database
        .insertInto('notification.notification_preferences')
        .values({ user_id: userId, created_at: now, updated_at: now })
        .onConflict((c) => c.column('user_id').doNothing())
        .execute();
    }
    const chat = await createReportChat(database, firstId, secondId);
    const [low, high] = [firstId, secondId].sort() as [string, string];
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        user_low_id: low,
        user_high_id: high,
        state: 'matched',
        reason_code: 'mutual_like',
        changed_at: now,
      })
      .execute();
    return { ...chat, first: await actor(firstId), second: await actor(secondId) };
  }
  async function question(
    owner: UserSessionActor,
    chatSessionId: string,
  ): Promise<
    Omit<SendPredefinedChatMessageWrite, 'command'> & { command: SendPredefinedQuestionCommand }
  > {
    const item = await database
      .selectFrom('chat.predefined_questions as question')
      .innerJoin(
        'chat.predefined_question_sets as catalog',
        'catalog.id',
        'question.question_set_id',
      )
      .select('question.id')
      .where('question.is_active', '=', true)
      .where('catalog.is_active', '=', true)
      .orderBy('question.id')
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    return {
      chatSessionId,
      messageId: randomUUID(),
      eventId: randomUUID(),
      command: {
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        commandType: 'chat.send-predefined-question',
        schemaVersion: 1,
        actor: { kind: 'user', userId: owner.userId },
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { chatActionToken: reference, questionId: item.id },
      },
    };
  }
  function envelope(owner: UserSessionActor): {
    commandId: string;
    requestId: string;
    idempotencyKey: string;
    schemaVersion: 1;
    actor: { kind: 'user'; userId: string };
    occurredAt: string;
    locale: string;
  } {
    const id = randomUUID();
    return {
      commandId: id,
      requestId: id,
      idempotencyKey: id,
      schemaVersion: 1,
      actor: { kind: 'user', userId: owner.userId },
      occurredAt: new Date().toISOString(),
      locale: 'en',
    };
  }
  it('uses the original grant for reads and twenty concurrent retries with one message and notification', async () => {
    const f = await conversation(),
      store = new PostgresChatStore(database, f.first),
      write = await question(f.first, f.chatSessionId);
    expect((await store.loadForMatch(f.first.userId, f.matchId)).canRead).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.sendPredefined(write)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.messageId))).toEqual(new Set([write.messageId]));
    const page = await new PostgresChatStateStore(database, f.first).readPage({
      userId: f.first.userId,
      chatSessionId: f.chatSessionId,
      limit: 50,
    });
    expect(page.items.map((m) => m.messageId)).toEqual([write.messageId]);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('deduplication_key', '=', `chat-message:${write.messageId}:${f.second.userId}`)
        .execute(),
    ).toHaveLength(1);
  });
  it('serializes opposite participants without reversing the shared pair and identity lock order', async () => {
    const f = await conversation();
    const writes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        question(i % 2 === 0 ? f.first : f.second, f.chatSessionId),
      ),
    );
    const results = await Promise.all(
      writes.map((w, i) =>
        new PostgresChatStore(database, i % 2 === 0 ? f.first : f.second).sendPredefined(w),
      ),
    );
    expect(new Set(results.map((r) => r.message.sequenceNumber)).size).toBe(20);
    expect(results.every((r) => !r.replayed)).toBe(true);
  });
  it('rejects revoked grants before reads, cached replies, warnings, state changes and Unmatch', async () => {
    const f = await conversation(),
      store = new PostgresChatStore(database, f.first),
      state = new PostgresChatStateStore(database, f.first);
    const write = await question(f.first, f.chatSessionId);
    const sent = await store.sendPredefined(write);
    await new PostgresUserSessionStore(database).revoke(
      f.first,
      f.first.sessionGrantId,
      randomUUID(),
    );
    const e = envelope(f.first);
    const operations = [
      () => store.loadForMatch(f.first.userId, f.matchId),
      () => store.loadForSession(f.first.userId, f.chatSessionId),
      () => state.readPage({ userId: f.first.userId, chatSessionId: f.chatSessionId, limit: 50 }),
      () => store.sendPredefined(write),
      () =>
        store.markSafetyWarningShown({
          userId: f.first.userId,
          chatSessionId: f.chatSessionId,
          expectedVersion: 1,
        }),
      () =>
        state.markRead({
          chatSessionId: f.chatSessionId,
          eventId: randomUUID(),
          command: {
            ...e,
            commandType: 'chat.mark-read',
            data: {
              chatActionToken: reference,
              throughSequenceNumber: sent.message.sequenceNumber,
            },
          },
        }),
      () =>
        state.changeMute({
          chatSessionId: f.chatSessionId,
          eventId: randomUUID(),
          command: {
            ...e,
            commandType: 'chat.change-mute',
            data: { chatActionToken: reference, muted: true, expectedVersion: 1 },
          },
        }),
      () =>
        new PostgresUnmatchStore(database, f.first).unmatch({
          matchId: f.matchId,
          eventId: randomUUID(),
          command: { ...e, commandType: 'matching.unmatch', data: { matchActionToken: 'fixture' } },
        }),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('chat_session_id', '=', f.chatSessionId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('matching.unmatch_records')
        .select('match_id')
        .where('match_id', '=', f.matchId)
        .execute(),
    ).toHaveLength(0);
  });
  it('rejects a borrowed or missing native grant without using current identity as a substitute', async () => {
    const f = await conversation(),
      borrowed = { ...f.first, sessionGrantId: f.second.sessionGrantId };
    await expect(
      new PostgresChatStore(database, borrowed).sendPredefined(
        await question(f.first, f.chatSessionId),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    // A valid UUID that has no canonical issued fact is never a usable grant.
    await expect(
      new PostgresChatStateStore(database, { ...f.first, sessionGrantId: randomUUID() }).readPage({
        userId: f.first.userId,
        chatSessionId: f.chatSessionId,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('captures the constructor actor and command before an observed native pair-lock wait', async () => {
    const f = await conversation(),
      original = { ...f.first },
      store = new PostgresChatStore(database, original);
    original.userId = f.second.userId;
    original.sessionGrantId = f.second.sessionGrantId;
    const initial = await question(f.first, f.chatSessionId),
      submitted = {
        ...initial,
        command: {
          ...initial.command,
          actor: { ...initial.command.actor },
          data: { ...initial.command.data },
        },
      };
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((r) => {
        release = r;
      }),
      acquired = new Promise<void>((r) => {
        ready = r;
      });
    let pid = 0;
    const blocker = database.transaction().execute(async (tx) => {
      pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!.pid;
      await lockUserPair(tx, f.first.userId, f.second.userId);
      ready();
      await held;
    });
    await acquired;
    const pending = store.sendPredefined(submitted);
    try {
      await vi.waitFor(
        async () => {
          const row = (
            await sql<{
              waiting: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`.execute(
              database,
            )
          ).rows[0]!;
          expect(row.waiting).toBe(true);
        },
        { timeout: 5000, interval: 20 },
      );
      submitted.chatSessionId = randomUUID();
      submitted.command.actor.userId = f.second.userId;
      submitted.command.data.questionId = randomUUID();
    } finally {
      release();
      await blocker;
    }
    const result = await pending;
    expect(result.message.messageId).toBe(initial.messageId);
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select(['chat_session_id', 'sender_user_id'])
        .where('id', '=', initial.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ chat_session_id: f.chatSessionId, sender_user_id: f.first.userId });
  });
  it('denies old chat authority after genuine native Root and separately approved Return', async () => {
    let old!: Awaited<ReturnType<typeof conversation>>;
    const fixture = await createAccountReturnFixture(database, {
      beforeEvidenceCheckpoint: async (lease) => {
        while ((await new PostgresAccountDeletionChatStore(database).archiveNext(lease)).hasMore) {
          /* native bounded batches */
        }
        while ((await new PostgresAccountDeletionMatchStore(database).archiveNext(lease)).hasMore) {
          /* native bounded batches */
        }
      },
      beforeProductCheckpoint: async (lease) => {
        for (const store of [
          new PostgresAccountDeletionNoticeStore(database),
          new PostgresAccountDeletionPairStore(database),
        ]) {
          while ((await store.purgeNext(lease)).purgedRows > 0) {
            /* native bounded batches */
          }
        }
      },
      beforeDeletion: async (userId) => {
        await database
          .updateTable('identity.accounts')
          .set({ state: 'active', version: sql<number>`version+1`, state_changed_at: new Date() })
          .where('user_id', '=', userId)
          .execute();
        old = await conversation(userId);
        await new PostgresChatStore(database, old.first).sendPredefined(
          await question(old.first, old.chatSessionId),
        );
      },
    });
    // The helper's provider/absence observations are synthetic, not real-provider acceptance.
    const id = randomUUID();
    await new PostgresAccountReturnStore(database, fixture.control).return({
      ...envelope(old.first),
      commandId: id,
      requestId: id,
      idempotencyKey: id,
      commandType: 'account.return',
      data: { expectedAccountVersion: fixture.version },
    });
    expect(
      await new PostgresUserSessionStore(database).current(old.first, old.first.sessionGrantId),
    ).toBeUndefined();
    await expect(
      new PostgresChatStore(database, old.first).loadForMatch(old.first.userId, old.matchId),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      new PostgresChatStateStore(database, old.first).readPage({
        userId: old.first.userId,
        chatSessionId: old.chatSessionId,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      new PostgresUnmatchStore(database, old.first).unmatch({
        matchId: old.matchId,
        eventId: randomUUID(),
        command: {
          ...envelope(old.first),
          commandType: 'matching.unmatch',
          data: { matchActionToken: 'fixture' },
        },
      }),
    ).rejects.toBeDefined();
  });
});
