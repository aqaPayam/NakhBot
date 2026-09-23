import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import { RunNakhReconciliationBatchHandler } from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresNakhReconciliationStore } from './nakh-reconciliation-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('M5 Nakh reconciliation', () => {
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

  it('resumes one bounded run and records identity-safe counter drift once', async () => {
    const userId = randomUUID();
    const now = new Date();
    await database
      .insertInto('identity.users')
      .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
      .execute();
    // Reconciliation must detect out-of-band drift that ordinary writes cannot create.
    // Keep the trigger bypass scoped to one dedicated database session.
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .updateTable('platform.user_counters')
          .set({
            pending_nakh_count: 1,
            version: sql<number>`version + 1`,
            updated_at: sql<Date>`clock_timestamp()`,
          })
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });

    const store = new PostgresNakhReconciliationStore(database);
    const proposedIds = Array.from({ length: 20 }, () => randomUUID());
    const resumed = await Promise.all(proposedIds.map((id) => store.resumeOrStart(id)));
    expect(new Set(resumed)).toHaveLength(1);
    const runId = resumed[0]!;
    const handler = new RunNakhReconciliationBatchHandler(store);
    const phases: string[] = [];
    let completed = false;
    for (let iteration = 0; iteration < 100 && !completed; iteration += 1) {
      const result = await handler.execute({ proposedRunId: randomUUID(), limit: 500 });
      expect(result.runId).toBe(runId);
      phases.push(result.phase);
      completed = result.completed;
    }
    expect(completed).toBe(true);
    expect(phases).toEqual(expect.arrayContaining(['flows', 'counters', 'pending', 'delivered']));

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
        .where('entity_id', '=', userId)
        .execute(),
    ]);
    expect(run.run_type).toBe('nakh');
    expect(run.status).toBe('succeeded');
    expect(BigInt(run.scanned_count)).toBeGreaterThan(0n);
    expect(BigInt(run.anomaly_count)).toBeGreaterThanOrEqual(1n);
    expect(run.finished_at).not.toBeNull();
    expect(anomalies).toEqual([
      {
        anomaly_type: 'pending_nakh_counter_drift',
        entity_type: 'user_counter',
        disposition: 'repair_scheduled',
        safe_detail: { recordedCount: '1', actualCount: '0' },
      },
    ]);
  });
});
