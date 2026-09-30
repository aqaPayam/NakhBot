import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  ReportTokens,
  SubmitChatReportHandler,
  type EvidenceRevealDraft,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { SystemIdGenerator } from './foundation-store.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresConfirmedReportEvidenceReveals } from './confirmed-evidence-reveal-store.js';
import { PostgresGetReportEvidenceActionsHandler } from './report-evidence-actions-store.js';
import {
  createReportChat,
  createReportFixtureAdmin,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresPrepareChatReportEvidenceHandler } from './chat-report-source-store.js';
import {
  PostgresChatReportSubmissionStore,
  PostgresSubmitChatReportHandler,
} from './chat-report-submission-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 73);
describe.skipIf(url === undefined)('transactional chat report submission', () => {
  let database: NakhDatabase;
  const reporters: string[] = [],
    values = new Map<string, string>();
  const tokens = new ReportTokens(
    {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        values.set(id, value);
        return Promise.resolve(true);
      },
    },
    key,
  );
  const snapshots = new AesGcmChatReportSnapshotProtector('chat-report-key', 1, key);
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
  async function prepare(
    target?: string,
  ): Promise<Readonly<{ command: SubmitReportCommand; chatSessionId: string }>> {
    const reporter = await createReportUser(database),
      targetId = target ?? (await createReportUser(database));
    reporters.push(reporter);
    const chat = await createReportChat(database, reporter, targetId),
      actor = { kind: 'user' as const, userId: reporter };
    const source = await tokens.issueSource(reporter, { kind: 'match', referenceId: chat.matchId });
    const prepared = await new PostgresPrepareChatReportEvidenceHandler(database, tokens).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: source.token,
        requestedEvidenceTypes: ['chat'],
      },
      actor,
    );
    return {
      chatSessionId: chat.chatSessionId,
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
          text: 'Private report explanation',
        },
      },
    };
  }
  it('commits one encrypted snapshot and review across concurrent retries, retains replay after token loss and emits no content', async () => {
    const input = await prepare();
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const handler = new SubmitChatReportHandler(
      {
        resolveIntent: async (token, actor) => {
          const intent = await tokens.resolveIntent(token, actor);
          if (++arrived === 6) release();
          await gate;
          return intent;
        },
      },
      new PostgresChatReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handler.execute(input.command, input.command.actor)),
    );
    expect(new Set(results.map((result) => result.reportId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const reportId = results[0]!.reportId;
    const saved = await database
      .selectFrom('moderation.report_snapshots')
      .selectAll()
      .where('report_id', '=', reportId)
      .execute();
    expect(saved).toHaveLength(1);
    const row = saved[0]!;
    expect(
      new AesGcmChatReportSnapshotReader({ resolve: () => key }).decrypt(
        { reportId, evidenceId: row.report_evidence_id },
        {
          snapshotType: row.snapshot_type,
          schemaVersion: row.schema_version,
          keyId: row.encryption_key_id,
          keyVersion: row.encryption_key_version,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          sha256: row.content_sha256,
        },
      ),
    ).toEqual({ evidenceType: 'chat', chatSessionId: input.chatSessionId, status: 'active' });
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_id', '=', reportId)
      .execute();
    expect(events).toEqual([
      { payload: { reportId, evidenceTypes: ['chat'], status: 'pending_review' } },
    ]);
    const stable = new PostgresSubmitChatReportHandler(database, tokens, snapshots);
    values.clear();
    expect((await stable.execute(input.command, input.command.actor)).replayed).toBe(true);
    await expect(
      stable.execute(
        { ...input.command, data: { ...input.command.data, text: 'Changed' } },
        input.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rolls back every report fact on invalid encrypted capture and rejects a session closed after preparation', async () => {
    const failed = await prepare();
    const handler = new PostgresSubmitChatReportHandler(database, tokens, {
      protect: (subject, content) => ({
        ...snapshots.protect(subject, content),
        ciphertext: Buffer.alloc(0),
      }),
    });
    await expect(handler.execute(failed.command, failed.command.actor)).rejects.toThrow();
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', failed.command.commandId)
        .execute(),
    ).toHaveLength(0);
    const closed = await prepare();
    await database
      .updateTable('chat.chat_sessions')
      .set({ status: 'closed', closed_at: new Date(), closed_reason: 'admin_action', version: 2 })
      .where('id', '=', closed.chatSessionId)
      .execute();
    await expect(
      new PostgresSubmitChatReportHandler(database, tokens, snapshots).execute(
        closed.command,
        closed.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', closed.command.commandId)
        .execute(),
    ).toHaveLength(0);
  });
  it('shares the durable ten-report limit across concurrent chat submissions', async () => {
    const { command } = await prepare(),
      handler = new PostgresSubmitChatReportHandler(database, tokens, snapshots);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        handler.execute(
          { ...command, commandId: randomUUID(), idempotencyKey: randomUUID() },
          command.actor,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'report_limit_reached' });
  });
  it('releases the captured chat only after confirmed audited access, never on replay or reference mismatch', async () => {
    const input = await prepare();
    const report = await new PostgresSubmitChatReportHandler(database, tokens, snapshots).execute(
      input.command,
      input.command.actor,
    );
    await database
      .updateTable('chat.chat_sessions')
      .set({
        status: 'closed',
        closed_at: new Date(),
        closed_reason: 'admin_action',
        version: 2,
      })
      .where('id', '=', input.chatSessionId)
      .execute();
    const admin = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: admin,
        role_code: 'super_admin',
        assigned_by_admin_id: admin,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, admin);
    const query = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: await fixture.issue({
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: report.reportId,
        expectedTargetVersion: 1,
      }),
    };
    const unsupported = await new PostgresGetReportEvidenceActionsHandler(
      database,
      fixture.tokens,
      fixture.key,
    ).execute(query, fixture.actor);
    expect(unsupported.items[0]!.revealActionToken).toBeUndefined();
    const selected = await new PostgresGetReportEvidenceActionsHandler(
      database,
      fixture.tokens,
      fixture.key,
      Date.now,
      ['chat'],
    ).execute(query, fixture.actor);
    const evidence = selected.items[0]!;
    const draft: EvidenceRevealDraft = {
      commandType: 'moderation.reveal-evidence',
      schemaVersion: 1,
      actor: fixture.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: evidence.revealActionToken!,
        evidenceId: evidence.evidenceId,
        reason: 'Review captured chat context',
      },
    };
    let decryptions = 0;
    const reader = new AesGcmChatReportSnapshotReader({ resolve: () => key });
    const handler = new PostgresConfirmedReportEvidenceReveals(
      database,
      fixture.tokens,
      fixture.key,
      {
        chat: {
          decrypt: (subject, snapshot) => {
            decryptions++;
            return reader.decrypt(subject, snapshot);
          },
        },
      },
    );
    const command = {
      ...draft,
      data: { ...draft.data, confirmationToken: await handler.prepare(draft, fixture.actor) },
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => handler.execute(command, fixture.actor)),
    );
    expect(decryptions).toBe(1);
    expect(results.filter((result) => result.value !== undefined)).toHaveLength(1);
    expect(results.find((result) => result.value !== undefined)!.value!.content).toEqual({
      evidenceType: 'chat',
      chatSessionId: input.chatSessionId,
      status: 'active',
    });
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('outcome')
        .where('command_id', '=', draft.commandId)
        .execute(),
    ).toEqual([{ outcome: 'revealed' }]);
    const corrupt = new PostgresConfirmedReportEvidenceReveals(
      database,
      fixture.tokens,
      fixture.key,
      {
        chat: {
          decrypt: () => ({ evidenceType: 'chat', chatSessionId: randomUUID(), status: 'active' }),
        },
      },
    );
    const changed = { ...draft, commandId: randomUUID(), idempotencyKey: randomUUID() };
    const denied = await corrupt.execute(
      {
        ...changed,
        data: { ...changed.data, confirmationToken: await corrupt.prepare(changed, fixture.actor) },
      },
      fixture.actor,
    );
    expect(denied.value).toBeUndefined();
    expect(denied.result).toBe('failed');
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('outcome')
        .where('command_id', '=', changed.commandId)
        .execute(),
    ).toEqual([{ outcome: 'rejected' }]);
  });
  it('counts five distinct chat reporters toward one restriction episode', async () => {
    const target = await createReportUser(database),
      inputs = await Promise.all(Array.from({ length: 5 }, () => prepare(target)));
    const handler = new PostgresSubmitChatReportHandler(database, tokens, snapshots);
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
