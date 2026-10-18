import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  IntegrityMessageReportSnapshotReader,
  ReportTokens,
  type UserSessionActor,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import {
  createReportUser,
  createReportChat,
  createReportMessage,
  createReportUnmatch,
} from './testing/report-fixture.js';
import {
  createPostgresUserReportServices,
  type ReportEvidenceCapabilities,
} from './report-services.js';
import {
  listEndedReportConversations,
  type ConversationReportScope,
} from './profile-report-submission-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresReportEntryStore } from './report-entry-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionNoticeStore } from './account-deletion-notice-store.js';
import { PostgresAccountDeletionPairStore } from './account-deletion-pair-store.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('original-grant conversation report entry', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  const key = Buffer.alloc(32, 97);
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_conversation_reports');
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
  it('issues no report-entry proof for absent ownership or an ineligible account', async () => {
    const owner = await createReportUser(database, true),
      store = new PostgresReportEntryStore(database);
    expect(await store.open({ userId: owner, productEpoch: 0 }, randomUUID())).toBeUndefined();
    const f = await context('match');
    await database
      .updateTable('identity.accounts')
      .set({ state: 'banned', version: sql<number>`version+1`, state_changed_at: new Date() })
      .where('user_id', '=', f.owner.userId)
      .execute();
    const before = await database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('event_type', '=', 'identity.user-session-issued.v1')
      .execute();
    expect(await store.open(f.owner, randomUUID())).toBeUndefined();
    expect(await store.open({ ...f.owner, productEpoch: 1 }, randomUUID())).toBeUndefined();
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .execute(),
    ).toHaveLength(before.length);
  });
  it('converges fresh report-entry retries without renewing a revoked original grant or changing incident authority', async () => {
    const f = await context('match'),
      sessions = new PostgresUserSessionStore(database),
      store = new PostgresReportEntryStore(database);
    await sessions.revoke(
      { userId: f.owner.userId, productEpoch: 0 },
      f.owner.sessionGrantId,
      randomUUID(),
    );
    const request = randomUUID();
    const entries = await Promise.all(
      Array.from({ length: 20 }, () => store.open(f.owner, request)),
    );
    expect(entries.every((entry) => entry !== undefined)).toBe(true);
    expect(new Set(entries.map((entry) => entry!.sessionGrantId)).size).toBe(1);
    const entry = entries[0]!;
    expect(entry.sessionGrantId).not.toBe(f.owner.sessionGrantId);
    expect(await sessions.current(f.owner, f.owner.sessionGrantId)).toBeUndefined();
    expect(await store.page(entry)).toEqual([
      {
        matchId: f.scope.conversation.matchId,
        chatSessionId: f.scope.conversation.chatSessionId,
        kind: 'match',
      },
    ]);
    await expect(
      prepared({ ...f, owner: entry, scope: { ...f.scope, actor: entry } }),
    ).resolves.toBeDefined();
    await expect(prepared(f)).rejects.toBeDefined();
  });
  it('pages only original-life conversation metadata and preserves immutable post-Unmatch deadlines', async () => {
    const first = await context('match'),
      store = new PostgresReportEntryStore(database);
    const expected = new Set([first.scope.conversation.matchId]);
    for (let i = 0; i < 21; i++)
      expected.add((await context('unmatched', first.owner.userId)).scope.conversation.matchId);
    await context('unmatched', first.owner.userId, new Date(Date.now() - 90 * 86400000));
    await context('match');
    const entry = (await store.open(first.owner, randomUUID()))!;
    const page = await store.page(entry);
    expect(page).toHaveLength(21);
    const next = await store.page(entry, page[19]!.matchId);
    expect(next).toHaveLength(2);
    const combined = [...page.slice(0, 20), ...next];
    expect(new Set(combined.map((row) => row.matchId))).toEqual(expected);
    expect(
      combined.every((row) => Object.keys(row).sort().join(',') === 'chatSessionId,kind,matchId'),
    ).toBe(true);
    await expect(store.page(entry, 'borrowed-selector')).rejects.toBeDefined();
  });
  async function actor(userId: string, productEpoch = 0): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch },
      randomUUID(),
    );
    if (grant === undefined) throw Error('Original report grant unavailable');
    return { kind: 'user', userId, productEpoch, sessionGrantId: grant.id };
  }
  async function context(
    kind: 'match' | 'message' | 'unmatched',
    existingOwner?: string,
    historicalTime?: Date,
    productEpoch = 0,
  ): Promise<{
    owner: UserSessionActor;
    peer: string;
    scope: ConversationReportScope;
  }> {
    const userId = existingOwner ?? (await createReportUser(database, true)),
      peer = await createReportUser(database, true);
    for (const user of [userId, peer]) {
      await database
        .insertInto('notification.notification_preferences')
        .values({ user_id: user, created_at: new Date(), updated_at: new Date() })
        .onConflict((c) => c.column('user_id').doNothing())
        .execute();
      await database
        .insertInto('identity.user_settings')
        .values({
          user_id: user,
          visibility_enabled: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((c) => c.column('user_id').doNothing())
        .execute();
    }
    const chat =
      kind === 'unmatched'
        ? await createReportUnmatch(database, userId, peer, historicalTime)
        : await createReportChat(database, userId, peer, new Date(), {
            first: productEpoch,
            second: 0,
          });
    if (kind !== 'unmatched') {
      const [low, high] = [userId, peer].sort() as [string, string];
      await database
        .insertInto('interaction.user_pair_states')
        .values({
          user_low_id: low,
          user_high_id: high,
          state: 'matched',
          reason_code: 'mutual_like',
          changed_at: new Date(),
        })
        .execute();
    }
    const owner = await actor(userId, productEpoch);
    const referenceId =
      kind === 'message'
        ? await createReportMessage(database, chat.chatSessionId, peer)
        : chat.matchId;
    return {
      owner,
      peer,
      scope: { actor: owner, conversation: { ...chat, source: { kind, referenceId } } },
    };
  }
  function ports(scope: ConversationReportScope): {
    services: ReturnType<typeof createPostgresUserReportServices>;
    tokens: ReportTokens;
    values: Map<string, string>;
  } {
    const values = new Map<string, string>();
    const tokens = ReportTokens.forLife(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          if (values.has(id)) return Promise.resolve(false);
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 98),
      scope.actor,
    );
    const capabilities: ReportEvidenceCapabilities =
      scope.conversation.source.kind === 'message'
        ? { message: { reader: new IntegrityMessageReportSnapshotReader() } }
        : scope.conversation.source.kind === 'match'
          ? {
              chat: {
                protector: new AesGcmChatReportSnapshotProtector('chat-report', 1, key),
                reader: new AesGcmChatReportSnapshotReader({ resolve: () => key }),
              },
            }
          : {
              unmatched_user: {
                protector: new AesGcmUnmatchedReportSnapshotProtector('chat-report', 1, key),
                reader: new AesGcmUnmatchedReportSnapshotReader({ resolve: () => key }),
              },
            };
    return {
      services: createPostgresUserReportServices(database, tokens, capabilities, scope),
      tokens,
      values,
    };
  }
  async function prepared(
    f: Awaited<ReturnType<typeof context>>,
    p = ports(f.scope),
  ): Promise<{
    services: ReturnType<typeof createPostgresUserReportServices>;
    command: SubmitReportCommand;
    values: Map<string, string>;
  }> {
    const source = await p.tokens.issueSource(f.owner.userId, f.scope.conversation.source),
      kind = f.scope.conversation.source.kind,
      intent = await p.services.prepare.execute(
        {
          actor: f.owner,
          requestId: randomUUID(),
          sourceActionToken: source.token,
          requestedEvidenceTypes: [
            kind === 'match' ? 'chat' : kind === 'message' ? 'message' : 'unmatched_user',
          ],
        },
        f.owner,
        f.owner.productEpoch,
        f.owner.sessionGrantId,
      );
    const id = randomUUID();
    return {
      services: p.services,
      values: p.values,
      command: {
        commandType: 'moderation.submit-report',
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        schemaVersion: 1,
        actor: { kind: 'user', userId: f.owner.userId },
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { evidenceIntentToken: intent.evidenceIntentToken, reasonCode: 'harassment' },
      },
    };
  }
  function submit(
    f: Awaited<ReturnType<typeof context>>,
    p: Awaited<ReturnType<typeof prepared>>,
  ): ReturnType<typeof p.services.submit.execute> {
    return p.services.submit.execute(
      p.command,
      f.owner,
      f.owner.productEpoch,
      f.owner.sessionGrantId,
    );
  }
  it('converges twenty native chat report submissions with one encrypted capture and no reveal capability', async () => {
    const f = await context('match'),
      mutable = {
        actor: { ...f.scope.actor },
        conversation: structuredClone(f.scope.conversation),
      },
      p = ports(mutable);
    expect(() => createPostgresUserReportServices(database, p.tokens, {}, undefined!)).toThrow();
    mutable.actor = { ...f.owner, sessionGrantId: randomUUID() };
    mutable.conversation = { ...mutable.conversation, matchId: randomUUID() };
    const report = await prepared(f, p),
      results = await Promise.all(Array.from({ length: 20 }, () => submit(f, report)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.reportId)).size).toBe(1);
    expect(Object.keys(report.services).sort()).toEqual(['prepare', 'submit']);
    const snapshots = await database
      .selectFrom('moderation.report_snapshots')
      .selectAll()
      .where('report_id', '=', results[0]!.reportId)
      .execute();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.snapshot_type).toBe('chat');
  });
  it('retains exact peer-message evidence without storing its body in source or selection tokens', async () => {
    const f = await context('message'),
      p = await prepared(f),
      result = await submit(f, p);
    expect([...p.values.values()].join(' ')).not.toContain('Private message evidence fixture');
    expect(
      await database
        .selectFrom('chat.chat_message_snapshots')
        .select('original_message_id')
        .where('report_id', '=', result.reportId)
        .execute(),
    ).toEqual([{ original_message_id: f.scope.conversation.source.referenceId }]);
  });
  it('rejects another conversation, self messages and messages outside the current fifty-message window', async () => {
    const f = await context('message'),
      otherPeer = await createReportUser(database, true),
      other = await createReportChat(database, f.owner.userId, otherPeer);
    const foreign = await createReportMessage(database, other.chatSessionId, otherPeer);
    const self = await createReportMessage(
      database,
      f.scope.conversation.chatSessionId,
      f.owner.userId,
    );
    for (const referenceId of [foreign, self])
      await expect(
        prepared({
          ...f,
          scope: {
            ...f.scope,
            conversation: { ...f.scope.conversation, source: { kind: 'message', referenceId } },
          },
        }),
      ).rejects.toBeDefined();
    for (let i = 0; i < 50; i++)
      await createReportMessage(database, f.scope.conversation.chatSessionId, f.peer);
    await expect(prepared(f)).rejects.toBeDefined();
  });
  it('denies borrowed grants and revocation before preparation and cached receipts', async () => {
    const f = await context('match'),
      p = await prepared(f);
    await submit(f, p);
    const borrowed = await actor(f.peer);
    await expect(
      p.services.submit.execute(
        p.command,
        borrowed,
        borrowed.productEpoch,
        borrowed.sessionGrantId,
      ),
    ).rejects.toBeDefined();
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    await expect(submit(f, p)).rejects.toBeDefined();
    await expect(prepared(f)).rejects.toBeDefined();
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', f.owner.userId)
        .execute(),
    ).toHaveLength(1);
  });
  it('uses immutable native Unmatch deadlines and exposes only bounded eligible context metadata', async () => {
    const f = await context('unmatched'),
      expired = await context('unmatched', undefined, new Date(Date.now() - 2 * 86400000));
    expect(await listEndedReportConversations(database, f.owner)).toEqual([
      { matchId: f.scope.conversation.matchId, chatSessionId: f.scope.conversation.chatSessionId },
    ]);
    const p = await prepared(f);
    await submit(f, p);
    const eligible = new Set([f.scope.conversation.matchId]);
    for (let i = 0; i < 21; i++) {
      const chat = await createReportUnmatch(
        database,
        f.owner.userId,
        await createReportUser(database, true),
      );
      eligible.add(chat.matchId);
    }
    const first = await listEndedReportConversations(database, f.owner);
    expect(first).toHaveLength(21);
    const next = await listEndedReportConversations(database, f.owner, first[19]!.matchId);
    expect(next).toHaveLength(2);
    expect(new Set([...first.slice(0, 20), ...next].map((row) => row.matchId))).toEqual(eligible);
    expect(await listEndedReportConversations(database, expired.owner)).toEqual([]);
    await expect(prepared(expired)).rejects.toBeDefined();
    await expect(
      sql`UPDATE matching.unmatch_records SET report_window_expires_at=clock_timestamp()+interval '1 day'
      WHERE match_id=${expired.scope.conversation.matchId}::uuid`.execute(database),
    ).rejects.toBeDefined();
  });
  it('denies both the old grant and a later-life grant after genuine Root and approved Return', async () => {
    let old!: Awaited<ReturnType<typeof context>>;
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        await database
          .updateTable('identity.accounts')
          .set({ state: 'active', version: sql<number>`version+1`, state_changed_at: new Date() })
          .where('user_id', '=', userId)
          .execute();
        old = await context('match', userId);
        expect(
          await new PostgresReportEntryStore(database).open(old.owner, randomUUID()),
        ).toBeDefined();
      },
      beforeEvidenceCheckpoint: async (lease) => {
        while ((await new PostgresAccountDeletionChatStore(database).archiveNext(lease)).hasMore) {
          /* native batches */
        }
        while ((await new PostgresAccountDeletionMatchStore(database).archiveNext(lease)).hasMore) {
          /* native batches */
        }
      },
      beforeProductCheckpoint: async (lease) => {
        for (const store of [
          new PostgresAccountDeletionNoticeStore(database),
          new PostgresAccountDeletionPairStore(database),
        ])
          while ((await store.purgeNext(lease)).purgedRows > 0) {
            /* native batches */
          }
      },
    });
    const id = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      commandType: 'account.return',
      schemaVersion: 1,
      commandId: id,
      requestId: id,
      idempotencyKey: id,
      actor: { kind: 'user', userId: old.owner.userId },
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: f.version },
    });
    // Seed product eligibility only; Root, epoch advance and approved Return
    // above remain genuine native transitions, not fabricated lifecycle rows.
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active', version: sql<number>`version+1`, state_changed_at: new Date() })
      .where('user_id', '=', old.owner.userId)
      .execute();
    const later = await actor(old.owner.userId, 1);
    const entryStore = new PostgresReportEntryStore(database);
    expect(await entryStore.open(old.owner, randomUUID())).toBeUndefined();
    expect(await entryStore.open(later, randomUUID())).toBeUndefined();
    expect(
      await new PostgresUserSessionStore(database).current(later, later.sessionGrantId),
    ).toBeDefined();
    const fresh = await context('match', old.owner.userId, undefined, 1);
    const entry = (await entryStore.open(later, randomUUID()))!;
    expect((await entryStore.page(entry)).map((row) => row.matchId)).toEqual([
      fresh.scope.conversation.matchId,
    ]);
    await expect(
      prepared({ ...fresh, owner: later, scope: { ...fresh.scope, actor: later } }),
    ).resolves.toBeDefined();
    await expect(prepared(old)).rejects.toBeDefined();
    await expect(
      prepared({ ...old, owner: later, scope: { ...old.scope, actor: later } }),
    ).rejects.toBeDefined();
  });
});
