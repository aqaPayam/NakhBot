import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  ReportTokens,
  SubmitSingleEvidenceReportHandler,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  createReportUnmatch,
  createReportFixtureAdmin,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresPrepareUnmatchedReportEvidenceHandler } from './unmatched-report-source-store.js';
import {
  PostgresUnmatchedReportSubmissionStore,
  PostgresSubmitUnmatchedReportHandler,
} from './unmatched-report-submission-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 73);
describe.skipIf(url === undefined)('transactional unmatch report submission', () => {
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
  const snapshots = new AesGcmUnmatchedReportSnapshotProtector('unmatched-report-key', 1, key);
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
    historicalTime?: Date,
  ): Promise<Readonly<{ command: SubmitReportCommand; matchId: string }>> {
    const reporter = await createReportUser(database),
      targetId = target ?? (await createReportUser(database));
    reporters.push(reporter);
    const chat = await createReportUnmatch(database, reporter, targetId, historicalTime),
      actor = { kind: 'user' as const, userId: reporter };
    const source = await tokens.issueSource(reporter, {
      kind: 'unmatched',
      referenceId: chat.matchId,
    });
    const prepared = await new PostgresPrepareUnmatchedReportEvidenceHandler(
      database,
      tokens,
    ).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: source.token,
        requestedEvidenceTypes: ['unmatched_user'],
      },
      actor,
    );
    return {
      matchId: chat.matchId,
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
    const handler = new SubmitSingleEvidenceReportHandler(
      {
        resolveIntent: async (token, actor) => {
          const intent = await tokens.resolveIntent(token, actor);
          if (++arrived === 6) release();
          await gate;
          return intent;
        },
      },
      new PostgresUnmatchedReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
      'unmatched_user',
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
      new AesGcmUnmatchedReportSnapshotReader({ resolve: () => key }).decrypt(
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
    ).toMatchObject({ evidenceType: 'unmatched_user' });
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_id', '=', reportId)
      .execute();
    expect(events).toEqual([
      { payload: { reportId, evidenceTypes: ['unmatched_user'], status: 'pending_review' } },
    ]);
    const stable = new PostgresSubmitUnmatchedReportHandler(database, tokens, snapshots);
    values.clear();
    expect((await stable.execute(input.command, input.command.actor)).replayed).toBe(true);
    await expect(
      stable.execute(
        { ...input.command, data: { ...input.command.data, text: 'Changed' } },
        input.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('shares the durable ten-report limit across concurrent unmatch submissions', async () => {
    const { command } = await prepare(),
      handler = new PostgresSubmitUnmatchedReportHandler(database, tokens, snapshots);
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
  it('rolls back all report facts when capture fails', async () => {
    const input = await prepare();
    const handler = new PostgresSubmitUnmatchedReportHandler(database, tokens, {
      protect: (subject, content) => ({
        ...snapshots.protect(subject, content),
        ciphertext: Buffer.alloc(0),
      }),
    });
    await expect(handler.execute(input.command, input.command.actor)).rejects.toThrow();
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', input.command.commandId)
        .execute(),
    ).toHaveLength(0);
  });
  it('enforces expiry at insertion after a later lock wait and preserves no partial report', async () => {
    const { now } = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database))
      .rows[0]!;
    const expires = new Date(now.getTime() + 5000);
    const input = await prepare(undefined, new Date(expires.getTime() - 86400000));
    let locked!: () => void, captured!: () => void;
    const ready = new Promise<void>((done) => {
      locked = done;
    });
    const captureReady = new Promise<void>((done) => {
      captured = done;
    });
    const blocker = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('moderation.report_reasons')
        .select('id')
        .where('code', '=', 'harassment')
        .forUpdate()
        .execute();
      locked();
      await captureReady;
      await sql`select pg_sleep_until(${expires.toISOString()}::timestamptz)`.execute(tx);
    });
    await ready;
    const handler = new PostgresSubmitUnmatchedReportHandler(database, tokens, {
      protect: (subject, content) => {
        captured();
        return snapshots.protect(subject, content);
      },
    });
    try {
      await expect(handler.execute(input.command, input.command.actor)).rejects.toMatchObject({
        code: 'report_unavailable',
      });
    } finally {
      captured();
      await blocker;
    }
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', input.command.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('causation_id', '=', input.command.commandId)
        .execute(),
    ).toHaveLength(0);
  });
  it('replays a committed receipt after window expiry but rejects a new command', async () => {
    const { now } = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database))
      .rows[0]!;
    const expires = new Date(now.getTime() + 4000);
    const input = await prepare(undefined, new Date(expires.getTime() - 86400000));
    const handler = new PostgresSubmitUnmatchedReportHandler(database, tokens, snapshots);
    const receipt = await handler.execute(input.command, input.command.actor);
    await sql`select pg_sleep_until(${expires.toISOString()}::timestamptz)`.execute(database);
    await expect(
      handler.execute(
        { ...input.command, commandId: randomUUID(), idempotencyKey: randomUUID() },
        input.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    values.clear();
    expect(await handler.execute(input.command, input.command.actor)).toEqual({
      ...receipt,
      replayed: true,
    });
  });
  it('counts five distinct unmatch reporters toward one restriction episode', async () => {
    const target = await createReportUser(database),
      inputs = await Promise.all(Array.from({ length: 5 }, () => prepare(target)));
    const handler = new PostgresSubmitUnmatchedReportHandler(database, tokens, snapshots);
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
