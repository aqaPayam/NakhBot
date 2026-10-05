import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODERATION_RECONCILIATION_PHASES } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { measureM7SyntheticPlans } from './m7-query-plans.js';
import { seedM7IntegrityPlans } from './m7-integrity-plan-fixture.js';
import { seedM7AppealIntegrityPlans } from './m7-appeal-integrity-plan-fixture.js';
import { withM6SyntheticPlanSession } from './m6-query-plans.js';
import {
  PostgresModerationIntegrityMetricsStore,
  withModerationIntegrityRead,
} from './moderation-integrity-metrics-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
class FixtureRollback extends Error {}
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
      'moderation.user_appeals',
      'moderation.appeal_unbans',
      'identity.account_state_history',
      'platform.audit_logs',
      'administration.admin_action_logs',
      'notification.notifications',
    ] as const) {
      const row = await database
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(row.count)).toBe(0);
    }
  }
  it('measures ten populated phases and the actual combined sampler, then removes every fixture', async () => {
    const { plans, terminalAppeals } = await measureM7SyntheticPlans(database, 1000);
    expect(terminalAppeals).toEqual({
      reviewed: 1000,
      accepted: 500,
      rejected: 500,
      acceptedWithoutUnban: 250,
      unbans: 250,
      restoredStates: 4,
    });
    for (const phase of MODERATION_RECONCILIATION_PHASES)
      expect(plans[`integrity_${phase}`]).toBeDefined();
    const plan = plans.integritySnapshot as { Plan: { 'Actual Rows': number } }[];
    expect(plan[0]?.Plan['Actual Rows']).toBe(10);
    for (const name of [
      'terminalAcceptedQueue',
      'terminalRejectedQueue',
      'terminalIntegrityAppeals',
      'terminalIntegrityActions',
      'terminalIntegrityAdminLogs',
      'terminalIntegritySnapshot',
    ])
      expect(plans[name]).toBeDefined();
    await assertClean();
  });
  it('keeps acceptance separate from unban and detects missing review, wrong command target and wrong restoration', async () => {
    await withM6SyntheticPlanSession(database, async (connection) => {
      try {
        await connection.transaction().execute(async (tx) => {
          const prefix = randomUUID(),
            at = new Date(),
            store = new PostgresModerationIntegrityMetricsStore(tx);
          await seedM7IntegrityPlans(tx, prefix, 1000, at);
          const baseline = await store.measure();
          await seedM7AppealIntegrityPlans(tx, prefix, 1000, at);
          expect((await store.measure()).counts).toEqual(baseline.counts);
          // Both accepted-without-unban and rejected decisions require their own review audit.
          for (const n of [1, 2]) {
            await sql`UPDATE platform.audit_logs SET request_id = ${randomUUID()}::uuid
              WHERE id = md5(${prefix} || 'terminal-review-audit' || ${n}::text)::uuid`.execute(tx);
            const broken = await store.measure();
            expect(broken.counts.appeals).toBe(baseline.counts.appeals + 1);
            expect(broken.counts.actions).toBe(baseline.counts.actions);
            await sql`UPDATE platform.audit_logs SET request_id = md5(${prefix} || 'terminal-review-request' || ${n}::text)::uuid
              WHERE id = md5(${prefix} || 'terminal-review-audit' || ${n}::text)::uuid`.execute(tx);
          }
          await sql`UPDATE administration.admin_action_logs SET target_id = md5(${prefix} || 'terminal-appeal2')::uuid
            WHERE id = md5(${prefix} || 'terminal-unban-attempt4')::uuid`.execute(tx);
          const wrongTarget = await store.measure();
          expect(wrongTarget.counts.appeals).toBe(baseline.counts.appeals + 1);
          expect(wrongTarget.counts.actions).toBe(baseline.counts.actions + 1);
          await sql`UPDATE administration.admin_action_logs SET target_id = md5(${prefix} || 'terminal-appeal4')::uuid
            WHERE id = md5(${prefix} || 'terminal-unban-attempt4')::uuid`.execute(tx);
          await sql`UPDATE identity.account_state_history SET next_state = 'active'
            WHERE id = md5(${prefix} || 'terminal-unban-history4')::uuid`.execute(tx);
          expect((await store.measure()).counts.actions).toBe(baseline.counts.actions + 1);
          await sql`UPDATE identity.account_state_history SET next_state = 'restricted'
            WHERE id = md5(${prefix} || 'terminal-unban-history4')::uuid`.execute(tx);
          await sql`UPDATE identity.account_state_history SET user_id = md5(${prefix} || 'terminal-user1')::uuid
            WHERE id = md5(${prefix} || 'terminal-ban2')::uuid`.execute(tx);
          expect((await store.measure()).counts.appeals).toBe(baseline.counts.appeals + 1);
          await sql`UPDATE identity.account_state_history SET user_id = md5(${prefix} || 'terminal-user2')::uuid
            WHERE id = md5(${prefix} || 'terminal-ban2')::uuid`.execute(tx);
          expect((await store.measure()).counts).toEqual(baseline.counts);
          throw new FixtureRollback();
        });
      } catch (error) {
        if (!(error instanceof FixtureRollback)) throw error;
      }
    });
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
