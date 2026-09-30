import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportTokens } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createReportUnmatch, createReportUser } from './testing/report-fixture.js';
import {
  PostgresPrepareUnmatchedReportEvidenceHandler,
  PostgresUnmatchedReportSourceStore,
  resolveUnmatchedReportSource,
} from './unmatched-report-source-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('post-unmatch report preparation', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 6,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  it('authorizes both participants after a real unmatch, binds opaque intents and denies outsiders', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database),
      outsider = await createReportUser(database);
    const chat = await createReportUnmatch(database, first, second);
    const source = { kind: 'unmatched' as const, referenceId: chat.matchId };
    const values = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 74),
    );
    const handler = new PostgresPrepareUnmatchedReportEvidenceHandler(database, tokens);
    for (const userId of [first, second]) {
      const actor = { kind: 'user' as const, userId };
      const query = {
        actor,
        requestId: randomUUID(),
        requestedEvidenceTypes: ['unmatched_user' as const],
        sourceActionToken: (await tokens.issueSource(userId, source)).token,
      };
      const prepared = await handler.execute(query, actor);
      expect(await tokens.resolveIntent(prepared.evidenceIntentToken, userId)).toEqual({
        source,
        targetUserId: userId === first ? second : first,
        evidence: [{ evidenceType: 'unmatched_user', referenceId: chat.matchId }],
      });
      expect(await tokens.resolveIntent(prepared.evidenceIntentToken, outsider)).toBeUndefined();
      for (const id of [first, second, chat.matchId])
        expect(JSON.stringify(prepared)).not.toContain(id);
      await expect(
        handler.execute({ ...query, requestedEvidenceTypes: ['profile'] }, actor),
      ).rejects.toMatchObject({ code: 'report_unavailable' });
    }
    const store = new PostgresUnmatchedReportSourceStore(database);
    expect(await store.resolve(outsider, source)).toBeUndefined();
    expect(await store.resolve(first, { ...source, kind: 'match' })).toBeUndefined();
    expect(await store.resolve(first, { ...source, referenceId: randomUUID() })).toBeUndefined();
  });
  it('rejects an expired immutable window', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database);
    const { now } = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database))
      .rows[0]!;
    const chat = await createReportUnmatch(
      database,
      first,
      second,
      new Date(now.getTime() - 86401000),
    );
    expect(
      await resolveUnmatchedReportSource(database, first, {
        kind: 'unmatched',
        referenceId: chat.matchId,
      }),
    ).toBeUndefined();
  });
  it('checks the database clock again after waiting on source locks', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database);
    const { now } = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database))
      .rows[0]!;
    const expires = new Date(now.getTime() + 5000);
    const chat = await createReportUnmatch(
      database,
      first,
      second,
      new Date(expires.getTime() - 86400000),
    );
    const source = { kind: 'unmatched' as const, referenceId: chat.matchId };
    expect(await resolveUnmatchedReportSource(database, first, source)).toBeDefined();
    let locked!: () => void;
    const ready = new Promise<void>((done) => {
      locked = done;
    });
    const blocker = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('matching.unmatch_records')
        .select('match_id')
        .where('match_id', '=', chat.matchId)
        .forUpdate()
        .execute();
      locked();
      await sql`select pg_sleep_until(${expires.toISOString()}::timestamptz)`.execute(tx);
    });
    await ready;
    const resolved = await database
      .transaction()
      .execute((tx) => resolveUnmatchedReportSource(tx, first, source, true));
    await blocker;
    expect(resolved).toBeUndefined();
  });
});
