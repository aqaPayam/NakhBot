import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import { RunChatReconciliationBatchHandler } from '@nakh/application';

import { PostgresChatReconciliationStore } from './chat-reconciliation-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('M6 chat reconciliation', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 30,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 10_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('resumes one bounded run and reports allocator drift without message content', async () => {
    const [userLowId, userHighId] = [randomUUID(), randomUUID()].sort();
    const matchId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    await database
      .insertInto('identity.users')
      .values([
        { id: userLowId!, last_activity_at: now, created_at: now, updated_at: now },
        { id: userHighId!, last_activity_at: now, created_at: now, updated_at: now },
      ])
      .execute();

    // Ordinary writes cannot create this drift. Keep trigger/FK bypass on one dedicated session;
    // all rows except the allocator remain structurally consistent for this scanner fixture.
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .insertInto('matching.matches')
          .values({
            id: matchId,
            user_low_id: userLowId!,
            user_high_id: userHighId!,
            source: 'mutual_like',
            source_like_a_id: randomUUID(),
            source_like_b_id: randomUUID(),
            source_nakh_id: null,
            status: 'active',
            created_at: now,
            closed_at: null,
          })
          .execute();
        await connection
          .insertInto('matching.match_participants')
          .values([
            { match_id: matchId, user_id: userLowId!, joined_at: now },
            { match_id: matchId, user_id: userHighId!, joined_at: now },
          ])
          .execute();
        await connection
          .insertInto('chat.chat_sessions')
          .values({
            id: sessionId,
            match_id: matchId,
            status: 'active',
            next_sequence_number: '2',
            created_at: now,
            closed_at: null,
            closed_reason: null,
          })
          .execute();
        await connection
          .insertInto('chat.chat_participants')
          .values([
            { chat_session_id: sessionId, user_id: userLowId! },
            { chat_session_id: sessionId, user_id: userHighId! },
          ])
          .execute();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });

    const store = new PostgresChatReconciliationStore(database);
    const proposedIds = Array.from({ length: 20 }, () => randomUUID());
    const resumed = await Promise.all(proposedIds.map((id) => store.resumeOrStart(id)));
    expect(new Set(resumed)).toHaveLength(1);
    const runId = resumed[0]!;
    const handler = new RunChatReconciliationBatchHandler(store);
    const phases: string[] = [];
    let completed = false;
    for (let iteration = 0; iteration < 100 && !completed; iteration += 1) {
      const result = await handler.execute({ proposedRunId: randomUUID(), limit: 500 });
      expect(result.runId).toBe(runId);
      phases.push(result.phase);
      completed = result.completed;
    }
    expect(completed).toBe(true);
    expect(phases).toEqual(
      expect.arrayContaining(['sessions', 'messages', 'unmatches', 'deliveries']),
    );

    const [run, anomalies] = await Promise.all([
      database
        .selectFrom('billing.reconciliation_runs')
        .select(['run_type', 'status', 'scanned_count', 'anomaly_count', 'finished_at'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('billing.reconciliation_anomalies')
        .select(['anomaly_type', 'entity_type', 'disposition', 'safe_detail'])
        .where('run_id', '=', runId)
        .where('entity_id', '=', sessionId)
        .execute(),
    ]);
    expect(run.run_type).toBe('chat');
    expect(run.status).toBe('succeeded');
    expect(BigInt(run.scanned_count)).toBeGreaterThan(0n);
    expect(BigInt(run.anomaly_count)).toBeGreaterThanOrEqual(1n);
    expect(run.finished_at).not.toBeNull();
    expect(anomalies).toEqual([
      {
        anomaly_type: 'chat_sequence_allocator_drift',
        entity_type: 'chat_session',
        disposition: 'quarantined',
        safe_detail: { nextSequenceNumber: '2', expectedNextSequenceNumber: '1' },
      },
    ]);
  });
});
