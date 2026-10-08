import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODERATION_RECONCILIATION_PHASES } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { analyzeM7QueryTables, measureM7SyntheticPlans } from './m7-query-plans.js';
import { seedM7IntegrityPlans } from './m7-integrity-plan-fixture.js';
import { seedM7AppealIntegrityPlans } from './m7-appeal-integrity-plan-fixture.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
import { withM6SyntheticPlanSession } from './m6-query-plans.js';
import {
  PostgresModerationIntegrityMetricsStore,
  moderationIntegrityPhaseStatement,
  withModerationIntegrityRead,
} from './moderation-integrity-metrics-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
class FixtureRollback extends Error {}
describe.skipIf(url === undefined)('M7 integrity plan fixture isolation', () => {
  let database: NakhDatabase;
  let initialJit: string;
  let initialWorkMem: string;
  const parallelSettings = [
    'parallel_setup_cost',
    'parallel_tuple_cost',
    'max_parallel_workers_per_gather',
  ] as const;
  const initialParallelSettings: Record<string, string> = {};
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
    initialWorkMem = (await sql<{ work_mem: string }>`SHOW work_mem`.execute(database)).rows[0]!
      .work_mem;
    for (const name of parallelSettings)
      initialParallelSettings[name] = (
        await sql<{ value: string }>`SELECT current_setting(${name}) AS value`.execute(database)
      ).rows[0]!.value;
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
    expect(
      (await sql<{ work_mem: string }>`SHOW work_mem`.execute(database)).rows[0]!.work_mem,
    ).toBe(initialWorkMem);
    for (const name of parallelSettings)
      expect(
        (await sql<{ value: string }>`SELECT current_setting(${name}) AS value`.execute(database))
          .rows[0]!.value,
      ).toBe(initialParallelSettings[name]);
    for (const table of [
      'moderation.reports',
      'moderation.report_evidence',
      'moderation.report_snapshots',
      'chat.chat_message_snapshots',
      'media.report_photo_evidence_holds',
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
    const { plans, terminalAppeals, encryptedCaptures, messageCaptures } =
      await measureM7SyntheticPlans(database, 1000);
    expect(encryptedCaptures).toEqual({
      authenticated: 1000,
      metadataIntact: 1000,
      byType: { profile: 250, photo: 250, chat: 250, unmatched_user: 250 },
      tagRejected: 1000,
      reportBindingRejected: 1000,
      evidenceBindingRejected: 1000,
      keyVersionRejected: 1000,
      hashRejected: 1000,
      outsideAdmissionWindow: 1000,
      admissionEligibleBefore: 3,
      admissionEligibleAfter: 3,
    });
    expect(messageCaptures).toEqual({
      integrityVerified: 1000,
      metadataIntact: 1000,
      byType: { text: 250, predefined_question: 250, predefined_answer: 250, system: 250 },
      reportBindingRejected: 1000,
      sessionBindingRejected: 1000,
      messageBindingRejected: 1000,
      contentRejected: 1000,
      shapeRejected: 1000,
      senderRejected: 1000,
      timestampRejected: 1000,
      hashRejected: 1000,
      outsideAdmissionWindow: 1000,
      admissionEligibleBefore: 3,
      admissionEligibleAfter: 3,
    });
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
    const healthPlan = plans.operationalHealth as { Plan: { 'Actual Rows': number } }[];
    expect(healthPlan[0]?.Plan['Actual Rows']).toBe(1);
    for (const name of [
      'terminalAcceptedQueue',
      'terminalRejectedQueue',
      'terminalIntegrityAppeals',
      'terminalIntegrityActions',
      'terminalIntegrityAdminLogs',
      'terminalIntegritySnapshot',
      'terminalOperationalHealth',
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
          await analyzeM7QueryTables(tx);
          const baseline = await store.measure();
          await seedM7AppealIntegrityPlans(tx, prefix, 1000, at);
          await analyzeM7QueryTables(tx);
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
          // A second matching metadata audit retains EXISTS cardinality: one Appeal.
          const duplicateAudit = randomUUID();
          await sql`INSERT INTO platform.audit_logs
            (id,category,event_type,actor_type,actor_admin_id,subject_type,subject_id,result_code,
              metadata_schema_version,request_id,command_id,occurred_at)
            SELECT ${duplicateAudit}::uuid,category,event_type,actor_type,actor_admin_id,subject_type,
              subject_id,result_code,metadata_schema_version,request_id,command_id,occurred_at
            FROM platform.audit_logs WHERE id=md5(${prefix} || 'terminal-review-audit1')::uuid`.execute(
            tx,
          );
          for (const sample of await Promise.all(Array.from({ length: 5 }, () => store.measure())))
            expect(sample.counts).toEqual(baseline.counts);
          await sql`DELETE FROM platform.audit_logs WHERE id=${duplicateAudit}::uuid`.execute(tx);
          throw new FixtureRollback();
        });
      } catch (error) {
        if (!(error instanceof FixtureRollback)) throw error;
      }
    });
    await assertClean();
  });
  it('preserves exact restoration history with valid and invalid duplicates under concurrent fresh-row reads', async () => {
    await withM6SyntheticPlanSession(database, async (connection) => {
      try {
        await connection.transaction().execute(async (tx) => {
          const prefix = randomUUID(),
            at = new Date(),
            store = new PostgresModerationIntegrityMetricsStore(tx);
          await seedM7IntegrityPlans(tx, prefix, 1000, at);
          await seedM7AppealIntegrityPlans(tx, prefix, 1000, at);
          await analyzeM7QueryTables(tx);
          const baseline = await store.measure();
          // An invalid duplicate must not hide a valid exact restoration history,
          // and multiple matches must not multiply the owning action.
          const duplicateHistory = randomUUID();
          await sql`INSERT INTO identity.account_state_history
            (id,user_id,previous_state,next_state,reason_code,actor_type,actor_user_id,actor_admin_id,changed_at)
            SELECT ${duplicateHistory}::uuid,user_id,'active',next_state,reason_code,actor_type,
              actor_user_id,actor_admin_id,changed_at FROM identity.account_state_history
            WHERE id=md5(${prefix} || 'terminal-unban-history4')::uuid`.execute(tx);
          const actionCount = async (): Promise<number> =>
            withModerationIntegrityRead(tx, async (read) =>
              Number(
                (await moderationIntegrityPhaseStatement('actions').execute(read)).rows[0]!.count,
              ),
            );
          for (const count of await Promise.all(Array.from({ length: 5 }, actionCount)))
            expect(count).toBe(baseline.counts.actions);
          await sql`UPDATE identity.account_state_history SET previous_state='active'
            WHERE id=md5(${prefix} || 'terminal-unban-history4')::uuid`.execute(tx);
          expect(await actionCount()).toBe(baseline.counts.actions + 1);
          await sql`UPDATE identity.account_state_history SET previous_state='banned',actor_admin_id=${randomUUID()}::uuid
            WHERE id=${duplicateHistory}::uuid`.execute(tx);
          // A valid previous state belonging to another admin cannot repair this action.
          expect(await actionCount()).toBe(baseline.counts.actions + 1);
          await sql`UPDATE identity.account_state_history SET actor_admin_id=md5(${prefix} || 'admin4')::uuid
            WHERE id=${duplicateHistory}::uuid`.execute(tx);
          expect(await actionCount()).toBe(baseline.counts.actions);
          await sql`UPDATE identity.account_state_history SET previous_state='banned'
            WHERE id=md5(${prefix} || 'terminal-unban-history4')::uuid`.execute(tx);
          expect(await actionCount()).toBe(baseline.counts.actions);
          await sql`DELETE FROM identity.account_state_history WHERE id=${duplicateHistory}::uuid`.execute(
            tx,
          );
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
    try {
      await expect(measureM7SyntheticPlans(database, 1000)).rejects.toThrow();
      await assertClean();
    } finally {
      // The deliberate collision belongs only to this fault test, not later seed scenarios.
      await database
        .deleteFrom('identity.telegram_identities')
        .where('user_id', '=', '00000000-0000-4000-8000-000000000001')
        .execute();
      await database
        .deleteFrom('identity.users')
        .where('id', '=', '00000000-0000-4000-8000-000000000001')
        .execute();
    }
  });
  it('keeps one action candidate per command and rejects changed actor, request and digest bindings', async () => {
    await withM6SyntheticPlanSession(database, async (connection) => {
      try {
        await connection.transaction().execute(async (tx) => {
          const prefix = randomUUID(),
            at = new Date();
          await seedM7IntegrityPlans(tx, prefix, 1000, at);
          await seedM7AppealIntegrityPlans(tx, prefix, 1000, at);
          await analyzeM7QueryTables(tx);
          const action = await tx
            .selectFrom('moderation.moderation_actions')
            .selectAll()
            .where(
              'id',
              '=',
              (
                await sql<{
                  id: string;
                }>`SELECT md5(${prefix} || 'terminal-unban-action4')::uuid AS id`.execute(tx)
              ).rows[0]!.id,
            )
            .executeTakeFirstOrThrow();
          const count = async (): Promise<number> =>
            withModerationIntegrityRead(tx, async (read) =>
              Number(
                (await moderationIntegrityPhaseStatement('admin_logs').execute(read)).rows[0]!
                  .count,
              ),
            );
          const baseline = await count();
          for (const changed of [
            { actor_admin_id: randomUUID() },
            { request_id: randomUUID() },
            { request_digest: '0'.repeat(64) },
            { command_id: randomUUID() },
          ]) {
            await tx
              .updateTable('moderation.moderation_actions')
              .set(changed)
              .where('id', '=', action.id)
              .execute();
            expect(await count()).toBe(baseline + 1);
            await tx
              .updateTable('moderation.moderation_actions')
              .set({
                actor_admin_id: action.actor_admin_id,
                request_id: action.request_id,
                request_digest: action.request_digest,
                command_id: action.command_id,
              })
              .where('id', '=', action.id)
              .execute();
            expect(await count()).toBe(baseline);
          }
          await tx
            .deleteFrom('moderation.moderation_actions')
            .where('id', '=', action.id)
            .execute();
          expect(await count()).toBe(baseline + 1);
          await tx.insertInto('moderation.moderation_actions').values(action).execute();
          expect(await count()).toBe(baseline);
          throw new FixtureRollback();
        });
      } catch (error) {
        if (!(error instanceof FixtureRollback)) throw error;
      }
    });
    await assertClean();
  });
  it('restores pooled compilation, memory and parallel settings after a failed integrity read', async () => {
    await expect(
      withModerationIntegrityRead(database, async (transaction) => {
        expect((await sql<{ jit: string }>`SHOW jit`.execute(transaction)).rows[0]!.jit).toBe(
          'off',
        );
        expect(
          (await sql<{ work_mem: string }>`SHOW work_mem`.execute(transaction)).rows[0]!.work_mem,
        ).toBe('16MB');
        for (const [name, expected] of [
          ['parallel_setup_cost', '1000'],
          ['parallel_tuple_cost', '0.03'],
        ])
          expect(
            (
              await sql<{ value: string }>`SELECT current_setting(${name}) AS value`.execute(
                transaction,
              )
            ).rows[0]!.value,
          ).toBe(expected);
        await sql`SELECT 1 / 0`.execute(transaction);
      }),
    ).rejects.toThrow('division by zero');
    await assertClean();
  });
  it('caps parallel workers, respects disabled/lower operator limits and restores a successful read', async () => {
    await database.connection().execute(async (connection) => {
      try {
        await sql`SELECT set_config('parallel_setup_cost','4321',false),
          set_config('parallel_tuple_cost','0.27',false)`.execute(connection);
        for (const limit of [0, 1, 8]) {
          await sql`SELECT set_config('max_parallel_workers_per_gather',${String(limit)},false)`.execute(
            connection,
          );
          await withModerationIntegrityRead(connection, async (read) => {
            for (const [name, expected] of [
              ['parallel_setup_cost', '1000'],
              ['parallel_tuple_cost', '0.03'],
            ])
              expect(
                (
                  await sql<{ value: string }>`SELECT current_setting(${name}) AS value`.execute(
                    read,
                  )
                ).rows[0]!.value,
              ).toBe(expected);
            expect(
              (
                await sql<{
                  value: string;
                }>`SELECT current_setting('max_parallel_workers_per_gather') AS value`.execute(read)
              ).rows[0]!.value,
            ).toBe(String(Math.min(limit, 2)));
          });
          expect(
            (
              await sql<{
                value: string;
              }>`SELECT current_setting('max_parallel_workers_per_gather') AS value`.execute(
                connection,
              )
            ).rows[0]!.value,
          ).toBe(String(limit));
          for (const [name, expected] of [
            ['parallel_setup_cost', '4321'],
            ['parallel_tuple_cost', '0.27'],
          ])
            expect(
              (
                await sql<{ value: string }>`SELECT current_setting(${name}) AS value`.execute(
                  connection,
                )
              ).rows[0]!.value,
            ).toBe(expected);
        }
      } finally {
        for (const name of parallelSettings)
          await sql`SELECT set_config(${name},${initialParallelSettings[name]!},false)`.execute(
            connection,
          );
      }
    });
    await assertClean();
  });
  it('keeps exact review and unban bindings under single-field drift and duplicate review audits', async () => {
    await withM6SyntheticPlanSession(database, async (connection) => {
      try {
        await connection.transaction().execute(async (tx) => {
          const prefix = randomUUID(),
            at = new Date();
          await seedM7IntegrityPlans(tx, prefix, 1000, at);
          await seedM7AppealIntegrityPlans(tx, prefix, 1000, at);
          await analyzeM7QueryTables(tx);
          const ids = (
            await sql<{
              appeal: string;
              audit: string;
              review: string;
              action: string;
              history: string;
              unban: string;
            }>`SELECT
            md5(${prefix} || 'terminal-appeal4')::uuid AS appeal,
            md5(${prefix} || 'terminal-review-audit4')::uuid AS audit,
            md5(${prefix} || 'terminal-review-attempt4')::uuid AS review,
            md5(${prefix} || 'terminal-unban-action4')::uuid AS action,
            md5(${prefix} || 'terminal-unban-history4')::uuid AS history,
            md5(${prefix} || 'terminal-unban-attempt4')::uuid AS unban`.execute(tx)
          ).rows[0]!;
          const count = async (): Promise<number> =>
            withModerationIntegrityRead(tx, async (read) =>
              Number(
                (await moderationIntegrityPhaseStatement('appeals').execute(read)).rows[0]!.count,
              ),
            );
          const flags = async (): Promise<{ hasReview: boolean; unbanMatches: boolean }> =>
            (
              await sql<{
                hasReview: boolean;
                unbanMatches: boolean;
              }>`SELECT "hasReview","unbanMatches" FROM (${MODERATION_INTEGRITY_SOURCES.appeals}) probe WHERE id=${ids.appeal}::uuid`.execute(
                tx,
              )
            ).rows[0]!;
          const baseline = await count();
          const audit = await tx
            .selectFrom('platform.audit_logs')
            .selectAll()
            .where('id', '=', ids.audit)
            .executeTakeFirstOrThrow();
          for (const changed of [
            { actor_admin_id: randomUUID() },
            { command_id: randomUUID() },
            { request_id: randomUUID() },
            { subject_id: randomUUID() },
            { subject_type: 'user' },
            { event_type: 'moderation.account-action.v1' },
            { result_code: 'appeal_rejected' },
          ]) {
            await tx
              .updateTable('platform.audit_logs')
              .set(changed)
              .where('id', '=', audit.id)
              .execute();
            expect(await flags()).toEqual({ hasReview: false, unbanMatches: true });
            expect(await count()).toBe(baseline + 1);
            await tx
              .updateTable('platform.audit_logs')
              .set(audit)
              .where('id', '=', audit.id)
              .execute();
            expect(await count()).toBe(baseline);
          }
          const review = await tx
            .selectFrom('administration.admin_action_logs')
            .selectAll()
            .where('id', '=', ids.review)
            .executeTakeFirstOrThrow();
          for (const changed of [
            { admin_user_id: randomUUID() },
            { command_id: randomUUID() },
            { request_id: randomUUID() },
            { target_id: randomUUID() },
            { target_type: 'user' },
            { command_code: 'moderation.unban-appeal' },
            { expected_target_version: review.expected_target_version! + 1 },
            { result: 'rejected' },
          ] as const) {
            await tx
              .updateTable('administration.admin_action_logs')
              .set(changed)
              .where('id', '=', review.id)
              .execute();
            expect((await flags()).hasReview).toBe(false);
            expect(await count()).toBe(baseline + 1);
            await tx
              .updateTable('administration.admin_action_logs')
              .set(review)
              .where('id', '=', review.id)
              .execute();
          }
          // Multiple matching audits keep existence semantics; a wrong outcome cannot
          // mask a valid one or become accepted after the valid audit is removed.
          const duplicate = randomUUID(),
            wrong = randomUUID();
          await tx
            .insertInto('platform.audit_logs')
            .values([
              { ...audit, id: duplicate },
              { ...audit, id: wrong, result_code: 'appeal_rejected' },
            ])
            .execute();
          expect(await count()).toBe(baseline);
          await tx
            .deleteFrom('platform.audit_logs')
            .where('id', 'in', [audit.id, duplicate])
            .execute();
          expect((await flags()).hasReview).toBe(false);
          expect(await count()).toBe(baseline + 1);
          await tx.insertInto('platform.audit_logs').values(audit).execute();
          expect(await count()).toBe(baseline);
          const history = await tx
            .selectFrom('identity.account_state_history')
            .selectAll()
            .where('id', '=', ids.history)
            .executeTakeFirstOrThrow();
          for (const changed of [
            { user_id: randomUUID() },
            { actor_admin_id: randomUUID() },
            { previous_state: 'active' },
            { changed_at: new Date(history.changed_at.getTime() + 1) },
          ] as const) {
            await tx
              .updateTable('identity.account_state_history')
              .set(changed)
              .where('id', '=', history.id)
              .execute();
            expect(await flags()).toEqual({ hasReview: true, unbanMatches: false });
            expect(await count()).toBe(baseline + 1);
            await tx
              .updateTable('identity.account_state_history')
              .set(history)
              .where('id', '=', history.id)
              .execute();
          }
          const unban = await tx
            .selectFrom('administration.admin_action_logs')
            .selectAll()
            .where('id', '=', ids.unban)
            .executeTakeFirstOrThrow();
          for (const changed of [
            { admin_user_id: randomUUID() },
            { command_id: randomUUID() },
            { target_id: randomUUID() },
            { target_type: 'user' },
            { command_code: 'moderation.review-appeal' },
            { result: 'rejected' },
          ] as const) {
            await tx
              .updateTable('administration.admin_action_logs')
              .set(changed)
              .where('id', '=', unban.id)
              .execute();
            expect((await flags()).unbanMatches).toBe(false);
            expect(await count()).toBe(baseline + 1);
            await tx
              .updateTable('administration.admin_action_logs')
              .set(unban)
              .where('id', '=', unban.id)
              .execute();
          }
          const action = await tx
            .selectFrom('moderation.moderation_actions')
            .selectAll()
            .where('id', '=', ids.action)
            .executeTakeFirstOrThrow();
          for (const changed of [
            { action_type: 'ban_user' },
            { target_user_id: randomUUID() },
            { actor_admin_id: randomUUID() },
            { command_id: randomUUID() },
            { occurred_at: new Date(action.occurred_at.getTime() + 1) },
          ] as const) {
            await tx
              .updateTable('moderation.moderation_actions')
              .set(changed)
              .where('id', '=', action.id)
              .execute();
            expect((await flags()).unbanMatches).toBe(false);
            expect(await count()).toBe(baseline + 1);
            await tx
              .updateTable('moderation.moderation_actions')
              .set(action)
              .where('id', '=', action.id)
              .execute();
          }
          expect(await flags()).toEqual({ hasReview: true, unbanMatches: true });
          expect(await count()).toBe(baseline);
          throw new FixtureRollback();
        });
      } catch (error) {
        if (!(error instanceof FixtureRollback)) throw error;
      }
    });
    await assertClean();
  });
});
