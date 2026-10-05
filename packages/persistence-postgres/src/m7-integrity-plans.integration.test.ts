import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODERATION_RECONCILIATION_PHASES } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { measureM7SyntheticPlans } from './m7-query-plans.js';
import {
  PostgresModerationIntegrityMetricsStore,
  withModerationIntegrityRead,
} from './moderation-integrity-metrics-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M7 integrity plan fixture isolation', () => {
  let database: NakhDatabase;
  let initialJit: string;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m7_plans');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 1,
      statementTimeoutMs: 60000,
      lockTimeoutMs: 10000,
    });
    initialJit = (await sql<{ jit: string }>`SHOW jit`.execute(database)).rows[0]!.jit;
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  async function assertClean(): Promise<void> {
    const sample = await new PostgresModerationIntegrityMetricsStore(database).measure();
    expect(Object.values(sample.counts)).toEqual(Array.from({ length: 10 }, () => 0));
    const role = (
      await sql<{ session_replication_role: string }>`SHOW session_replication_role`.execute(
        database,
      )
    ).rows[0];
    expect(role?.session_replication_role).toBe('origin');
    expect((await sql<{ jit: string }>`SHOW jit`.execute(database)).rows[0]!.jit).toBe(initialJit);
    for (const table of [
      'moderation.reports',
      'support.support_threads',
      'moderation.moderation_actions',
      'interaction.user_pair_states',
    ] as const) {
      const row = await database
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(row.count)).toBe(0);
    }
  }
  it('measures ten populated phases and the actual combined sampler, then removes every fixture', async () => {
    const plans = await measureM7SyntheticPlans(database, 1000);
    for (const phase of MODERATION_RECONCILIATION_PHASES)
      expect(plans[`integrity_${phase}`]).toBeDefined();
    const plan = plans.integritySnapshot as { Plan: { 'Actual Rows': number } }[];
    expect(plan[0]?.Plan['Actual Rows']).toBe(10);
    await assertClean();
  });
  it('rolls back earlier fixture writes and restores owning triggers when a later seed fails', async () => {
    // Collide with a fixture's verified identity after the earlier support/report writes.
    await sql`INSERT INTO identity.users (id,last_activity_at,created_at,updated_at)
      VALUES ('00000000-0000-4000-8000-000000000001',now(),now(),now())`.execute(database);
    await sql`INSERT INTO identity.telegram_identities (user_id,telegram_user_id,first_seen_at,last_seen_at)
      VALUES ('00000000-0000-4000-8000-000000000001',9000000000001,now(),now())`.execute(database);
    await expect(measureM7SyntheticPlans(database, 1000)).rejects.toThrow();
    await assertClean();
  });
  it('restores the pooled compilation setting after a failed integrity read', async () => {
    await expect(
      withModerationIntegrityRead(database, async (transaction) => {
        expect((await sql<{ jit: string }>`SHOW jit`.execute(transaction)).rows[0]!.jit).toBe(
          'off',
        );
        await sql`SELECT 1 / 0`.execute(transaction);
      }),
    ).rejects.toThrow('division by zero');
    await assertClean();
  });
});
