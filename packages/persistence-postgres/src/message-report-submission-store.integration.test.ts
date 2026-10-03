import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IntegrityMessageReportSnapshotReader,
  ReportTokens,
  SubmitMessageReportHandler,
} from '@nakh/application';
import type { SubmitReportCommand, CleanupChatCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { SystemIdGenerator } from './foundation-store.js';
import { PostgresChatRetentionStore } from './chat-retention-store.js';
import { PostgresSingleEvidenceReportSubmissionStore } from './profile-report-submission-store.js';
import { PostgresPrepareMessageReportEvidenceHandler } from './message-report-source-store.js';
import {
  PostgresMessageReportSubmissionStore,
  PostgresSubmitMessageReportHandler,
  captureMessageReportEvidence,
} from './message-report-submission-store.js';
import {
  createReportChat,
  createReportMessage,
  createReportUser,
  createReportFixtureAdmin,
} from './testing/report-fixture.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('atomic M7 report and M6 message capture', () => {
  let database: NakhDatabase;
  const reporters: string[] = [],
    state = new Map<string, string>(),
    tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(state.get(id)),
        putIfAbsent: (id, value) => {
          state.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 83),
    );
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 20,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 25000,
    });
  });
  afterAll(async () => {
    if (database === undefined) return;
    if (reporters.length > 0) {
      const admin = await createReportFixtureAdmin(database);
      await database
        .updateTable('moderation.moderation_reviews')
        .set({
          status: 'in_review',
          assigned_admin_id: admin,
          assigned_at: sql<Date>`transaction_timestamp()`,
          updated_at: sql<Date>`transaction_timestamp()`,
          version: sql<number>`version + 1`,
        })
        .where('status', '=', 'pending')
        .where(
          'report_id',
          'in',
          database
            .selectFrom('moderation.reports')
            .select('id')
            .where('reporter_user_id', 'in', reporters),
        )
        .execute();
    }
    await database.destroy();
  });
  async function prepare(target?: string): Promise<
    Readonly<{
      command: SubmitReportCommand;
      messageId: string;
      chatSessionId: string;
      target: string;
    }>
  > {
    const reporter = await createReportUser(database),
      targetId = target ?? (await createReportUser(database)),
      chat = await createReportChat(database, reporter, targetId),
      messageId = await createReportMessage(database, chat.chatSessionId, targetId),
      actor = { kind: 'user' as const, userId: reporter };
    reporters.push(reporter);
    const prepared = await new PostgresPrepareMessageReportEvidenceHandler(
      database,
      tokens,
    ).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: (
          await tokens.issueSource(reporter, { kind: 'message', referenceId: messageId })
        ).token,
        requestedEvidenceTypes: ['message'],
      },
      actor,
    );
    return {
      messageId,
      chatSessionId: chat.chatSessionId,
      target: targetId,
      command: {
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          evidenceIntentToken: prepared.evidenceIntentToken,
          reasonCode: 'harassment',
          text: 'Private complaint fixture',
        },
      },
    };
  }
  function cleanup(chatSessionId: string): CleanupChatCommand {
    return {
      commandType: 'chat.cleanup',
      schemaVersion: 1,
      actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { chatSessionId, deleteBatchSize: 100 },
    };
  }
  it('commits one M6 snapshot across retries, keeps content out of events, and replays after live cleanup and token loss', async () => {
    const input = await prepare();
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const handler = new SubmitMessageReportHandler(
      {
        resolveIntent: async (token, actor) => {
          const intent = await tokens.resolveIntent(token, actor);
          if (++arrived === 6) release();
          await gate;
          return intent;
        },
      },
      new PostgresMessageReportSubmissionStore(database),
      new SystemIdGenerator(),
    );
    const results = await Promise.all(
        Array.from({ length: 6 }, () => handler.execute(input.command, input.command.actor)),
      ),
      reportId = results[0]!.reportId;
    expect(new Set(results.map((result) => result.reportId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const saved = await database
      .selectFrom('chat.chat_message_snapshots')
      .selectAll()
      .where('report_id', '=', reportId)
      .execute();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      original_message_id: input.messageId,
      chat_session_id: input.chatSessionId,
      message_type: 'text',
      content: { text: 'Private message evidence fixture' },
    });
    expect(saved[0]!.integrity_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const snapshot = saved[0]!;
    const stored = {
      reportId: snapshot.report_id,
      chatSessionId: snapshot.chat_session_id,
      originalMessageId: snapshot.original_message_id,
      senderUserId: snapshot.sender_user_id,
      messageType: snapshot.message_type,
      content: snapshot.content,
      originalCreatedAt: snapshot.original_created_at,
      integritySha256: snapshot.integrity_sha256,
    };
    const reader = new IntegrityMessageReportSnapshotReader();
    const subject = { reportId, chatSessionId: input.chatSessionId, messageId: input.messageId };
    expect(reader.read(subject, stored)).toMatchObject({
      evidenceType: 'message',
      content: 'Private message evidence fixture',
      messageId: input.messageId,
    });
    expect(() =>
      reader.read(subject, { ...stored, content: { text: 'Changed evidence' } }),
    ).toThrow('Report snapshot could not be read.');
    expect(
      await database
        .selectFrom('moderation.report_snapshots')
        .select('id')
        .where('report_id', '=', reportId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select('id')
        .where('report_id', '=', reportId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('payload')
        .where('aggregate_id', '=', reportId)
        .execute(),
    ).toEqual([{ payload: { reportId, evidenceTypes: ['message'], status: 'pending_review' } }]);
    for (let index = 0; index < 50; index++)
      await createReportMessage(database, input.chatSessionId, input.target, 'Later message');
    await new PostgresChatRetentionStore(database).cleanupChat(cleanup(input.chatSessionId));
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('id', '=', input.messageId)
        .execute(),
    ).toHaveLength(0);
    state.clear();
    expect(reader.read(subject, stored).content).toBe('Private message evidence fixture');
    const stable = new PostgresSubmitMessageReportHandler(database, tokens);
    expect((await stable.execute(input.command, input.command.actor)).replayed).toBe(true);
    await expect(
      stable.execute(
        { ...input.command, data: { ...input.command.data, text: 'Changed complaint' } },
        input.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(
      await database
        .selectFrom('chat.chat_message_snapshots')
        .select('content')
        .where('report_id', '=', reportId)
        .execute(),
    ).toEqual([{ content: { text: 'Private message evidence fixture' } }]);
  });
  it('rolls back Report, request and snapshot when M6 capture fails after writing, then safely retries; rejects a purged prepared message', async () => {
    const input = await prepare();
    let attemptedReport = '';
    const store = new PostgresSingleEvidenceReportSubmissionStore(database, {
      capture: async (tx, write) => {
        attemptedReport = write.reportId;
        const captured = await captureMessageReportEvidence(tx, write),
          snapshot = captured.snapshot;
        if (snapshot.snapshotType !== 'message') throw new Error('fixture type');
        return {
          ...captured,
          snapshot: {
            snapshotType: 'message',
            capture: async (transaction) => {
              await snapshot.capture(transaction);
              throw new Error('fixture capture failure');
            },
          },
        };
      },
    });
    await expect(
      new SubmitMessageReportHandler(tokens, store, new SystemIdGenerator()).execute(
        input.command,
        input.command.actor,
      ),
    ).rejects.toThrow('fixture capture failure');
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', input.command.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('chat.chat_message_snapshot_requests')
        .select('report_id')
        .where('report_id', '=', attemptedReport)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('chat.chat_message_snapshots')
        .select('id')
        .where('report_id', '=', attemptedReport)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', attemptedReport)
        .execute(),
    ).toHaveLength(0);
    const stable = new PostgresSubmitMessageReportHandler(database, tokens);
    expect((await stable.execute(input.command, input.command.actor)).replayed).toBe(false);
    const purged = await prepare();
    await createReportMessage(database, purged.chatSessionId, purged.target);
    await database.deleteFrom('chat.chat_messages').where('id', '=', purged.messageId).execute();
    await expect(stable.execute(purged.command, purged.command.actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
  });
  it('serializes cleanup against report capture so a purged source is rejected or its immutable evidence is committed first', async () => {
    const input = await prepare();
    for (let index = 0; index < 50; index++)
      await createReportMessage(database, input.chatSessionId, input.target, 'Newer message');
    const [report, cleaned] = await Promise.allSettled([
      new PostgresSubmitMessageReportHandler(database, tokens).execute(
        input.command,
        input.command.actor,
      ),
      new PostgresChatRetentionStore(database).cleanupChat(cleanup(input.chatSessionId)),
    ]);
    expect(cleaned.status).toBe('fulfilled');
    if (report.status === 'fulfilled')
      expect(
        await database
          .selectFrom('chat.chat_message_snapshots')
          .select('content')
          .where('report_id', '=', report.value.reportId)
          .execute(),
      ).toEqual([{ content: { text: 'Private message evidence fixture' } }]);
    else {
      expect(report.reason).toMatchObject({ code: 'report_unavailable' });
      expect(
        await database
          .selectFrom('moderation.reports')
          .select('id')
          .where('command_id', '=', input.command.commandId)
          .execute(),
      ).toHaveLength(0);
    }
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('id', '=', input.messageId)
        .execute(),
    ).toHaveLength(0);
  });
  it('uses the shared ten-report admission limit under concurrent message submissions', async () => {
    const input = await prepare(),
      handler = new PostgresSubmitMessageReportHandler(database, tokens);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        handler.execute(
          { ...input.command, commandId: randomUUID(), idempotencyKey: randomUUID() },
          input.command.actor,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'report_limit_reached' });
  });
  it('counts five distinct message reporters toward one system restriction', async () => {
    const target = await createReportUser(database),
      inputs = await Promise.all(Array.from({ length: 5 }, () => prepare(target))),
      handler = new PostgresSubmitMessageReportHandler(database, tokens);
    await Promise.all(inputs.map((input) => handler.execute(input.command, input.command.actor)));
    expect(
      await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', target)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'restricted' });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_user_id', '=', target)
        .where('action_type', '=', 'restrict_user')
        .execute(),
    ).toHaveLength(1);
  });
});
