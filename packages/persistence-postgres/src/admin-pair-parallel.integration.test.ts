import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalAdminPairTargetId } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const low = '10000000-0000-4000-8000-000000000001';
type WorkerPlan = readonly {
  Plan: { 'Workers Planned': number; 'Workers Launched': number; 'Actual Rows': number };
}[];
describe.skipIf(url === undefined)('canonical administrator pair target parallel execution', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_pair_parallel');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 1,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 1000,
    });
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  it('executes in an actual worker and agrees with application binding for every pair', async () => {
    await database.transaction().execute(async (tx) => {
      // Test-only worker admission. Production planner settings and budgets are unchanged.
      await sql`SET LOCAL debug_parallel_query = on`.execute(tx);
      const targets = sql<{ n: number; target: string }>`SELECT n,
        moderation.admin_pair_target_id(${low}::uuid,
          ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid) AS target
        FROM generate_series(1,1000) n`;
      const plan = (
        await sql<{ 'QUERY PLAN': WorkerPlan }>`EXPLAIN (ANALYZE, FORMAT JSON) ${targets}`.execute(
          tx,
        )
      ).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Workers Planned']).toBe(1);
      expect(plan['Workers Launched']).toBe(1);
      expect(plan['Actual Rows']).toBe(1000);
      const rows = (await targets.execute(tx)).rows;
      expect(rows).toHaveLength(1000);
      expect(
        rows.every(
          (row) =>
            row.target ===
            canonicalAdminPairTargetId({
              userLowId: low,
              userHighId: `20000000-0000-4000-8000-${String(row.n).padStart(12, '0')}`,
            }),
        ),
      ).toBe(true);
    });
  });
  it('retains strict null handling and rejects unordered pairs under worker admission', async () => {
    expect(
      (
        await sql<{
          missing: boolean;
        }>`SELECT moderation.admin_pair_target_id(NULL::uuid,${low}::uuid)
        IS NULL AS missing`.execute(database)
      ).rows,
    ).toEqual([{ missing: true }]);
    await expect(
      database.transaction().execute(async (tx) => {
        await sql`SET LOCAL debug_parallel_query = on`.execute(tx);
        await sql`SELECT moderation.admin_pair_target_id(
          ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,${low}::uuid)
          FROM generate_series(1,1000) n`.execute(tx);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
