import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_DELETION_PHASES } from '@nakh/domain';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import {
  PostgresAccountDeletionHealthStore,
  accountDeletionHealthStatement,
} from './account-deletion-health-store.js';
import { withM6SyntheticPlanSession } from './m6-query-plans.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
class Rollback extends Error {}
describe.skipIf(url === undefined)('M8 native aggregate deletion health', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    health: PostgresAccountDeletionHealthStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_deletion_health');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 5,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 5000,
    });
    health = new PostgresAccountDeletionHealthStore(database);
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  it('returns eight complete zero phases from one native time and no identifiers', async () => {
    const sample = await health.measure();
    expect(Object.keys(sample.phases).sort()).toEqual([...ACCOUNT_DELETION_PHASES].sort());
    expect(sample.sampledAt).toBeInstanceOf(Date);
    for (const phase of ACCOUNT_DELETION_PHASES)
      expect(sample.phases[phase]).toEqual({
        records: 0,
        leased: 0,
        retrying: 0,
        inconsistent: 0,
        oldestAgeSeconds: 0,
        dueAgeSeconds: 0,
      });
    expect(Object.keys(sample)).toEqual(['sampledAt', 'phases']);
  });
  it('observes native lease expiry, reacquisition and scheduled retry without extending authority', async () => {
    const f = await createDeletionFixture(database),
      work = new PostgresAccountDeletionWorkStore(database);
    const [first] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 1000 });
    expect(first?.deletionRecordId).toBe(f.recordId);
    const held = await health.measure();
    expect(held.phases.shared_closure).toMatchObject({
      records: 1,
      leased: 1,
      retrying: 0,
      inconsistent: 0,
      dueAgeSeconds: 0,
    });
    await sql`SELECT pg_sleep(1.1)`.execute(database);
    const expired = await health.measure();
    expect(expired.phases.shared_closure.leased).toBe(0);
    expect(expired.phases.shared_closure.dueAgeSeconds).toBeGreaterThanOrEqual(1);
    const [second] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
    expect(second!.leaseGeneration).toBe(first!.leaseGeneration + 1);
    await work.retry(second!, 'deletion_provider_unavailable', 60);
    const retry = await health.measure();
    expect(retry.phases.shared_closure).toMatchObject({
      records: 1,
      leased: 0,
      retrying: 1,
      inconsistent: 0,
      dueAgeSeconds: 0,
    });
    expect(JSON.stringify(retry)).not.toContain(f.userId);
    expect(JSON.stringify(retry)).not.toContain(f.recordId);
    expect(JSON.stringify(retry)).not.toContain('deletion_provider_unavailable');
  });
  it('detects missing work and orphan work under explicit corruption while rollback restores native state', async () => {
    const f = await createDeletionFixture(database),
      before = await health.measure();
    await expect(
      withM6SyntheticPlanSession(database, (c) =>
        c.transaction().execute(async (tx) => {
          const work = (
            await sql<{
              work: Record<string, unknown>;
            }>`SELECT to_jsonb(work) AS work FROM identity.account_deletion_work work WHERE deletion_record_id=${f.recordId}::uuid`.execute(
              tx,
            )
          ).rows[0]!.work;
          await sql`DELETE FROM identity.account_deletion_work WHERE deletion_record_id=${f.recordId}::uuid`.execute(
            tx,
          );
          expect(
            (await new PostgresAccountDeletionHealthStore(tx).measure()).phases.shared_closure
              .inconsistent,
          ).toBe(before.phases.shared_closure.inconsistent + 1);
          await sql`INSERT INTO identity.account_deletion_work SELECT (jsonb_populate_record(NULL::identity.account_deletion_work,${JSON.stringify(work)}::jsonb)).*`.execute(
            tx,
          );
          await sql`DELETE FROM identity.account_deletion_records WHERE id=${f.recordId}::uuid`.execute(
            tx,
          );
          expect(
            (await new PostgresAccountDeletionHealthStore(tx).measure()).phases.shared_closure
              .inconsistent,
          ).toBe(before.phases.shared_closure.inconsistent + 1);
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect((await health.measure()).phases.shared_closure.inconsistent).toBe(0);
  });
  it('keeps a completed Root healthy after real separately approved Return moves the Account to a fresh epoch', async () => {
    const f = await createAccountReturnFixture(database),
      id = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: f.userId },
      requestId: id,
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: f.version },
    });
    expect((await health.measure()).phases.completed).toEqual({
      records: 1,
      leased: 0,
      retrying: 0,
      inconsistent: 0,
      oldestAgeSeconds: 0,
      dueAgeSeconds: 0,
    });
    expect(
      (
        await sql`SELECT identity.account_return_completed(${f.recordId}::uuid) AS valid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
  });
  it('measures all eight phases at 20000 metadata rows within the unchanged 1500 ms budget without fixture persistence', async () => {
    const baseline = await health.measure();
    await expect(
      withM6SyntheticPlanSession(database, (c) =>
        c.transaction().execute(async (tx) => {
          // Synthetic metadata scale only: no deletion, cleanup or approval is claimed.
          // Every inserted row is rolled back; owning triggers are restored by the helper.
          const prefix = randomUUID();
          await sql`INSERT INTO identity.users(id,last_activity_at,created_at,updated_at) SELECT md5(${prefix}||'u'||n)::uuid,now(),now(),now() FROM generate_series(1,20000) n`.execute(
            tx,
          );
          await sql`INSERT INTO identity.accounts(user_id,state,state_changed_at,version) SELECT md5(${prefix}||'u'||n)::uuid,'deleted',now(),2 FROM generate_series(1,20000) n`.execute(
            tx,
          );
          await sql`INSERT INTO identity.account_deletion_records(id,user_id,confirmation_id,account_version,history_id,audit_id,event_id,command_id,request_id,requested_at,phase,checkpoint_version,safety_bar,completed_at,product_purged_at)
      SELECT md5(${prefix}||'r'||n)::uuid,md5(${prefix}||'u'||n)::uuid,md5(${prefix}||'c'||n)::uuid,2,md5(${prefix}||'h'||n)::uuid,md5(${prefix}||'a'||n)::uuid,md5(${prefix}||'e'||n)::uuid,md5(${prefix}||'cmd'||n)::uuid,md5(${prefix}||'req'||n)::uuid,now()-interval '2 hours',
        (ARRAY['shared_closure','evidence_capture','product_data','media_objects','ephemeral_access','retention_manifest','verification','completed'])[(n-1)%8+1],(n-1)%8+1,'none',CASE WHEN n%8=0 THEN now()-interval '1 hour' END,CASE WHEN n%8=0 THEN now()-interval '1 hour' END FROM generate_series(1,20000) n`.execute(
            tx,
          );
          await sql`INSERT INTO identity.account_deletion_work(deletion_record_id,phase,checkpoint_version,available_at) SELECT md5(${prefix}||'r'||n)::uuid,(ARRAY['shared_closure','evidence_capture','product_data','media_objects','ephemeral_access','retention_manifest','verification','completed'])[(n-1)%8+1],(n-1)%8+1,now()-interval '1 hour' FROM generate_series(1,20000) n`.execute(
            tx,
          );
          await sql`ANALYZE identity.account_deletion_records`.execute(tx);
          await sql`ANALYZE identity.account_deletion_work`.execute(tx);
          await sql`ANALYZE identity.accounts`.execute(tx);
          const statement = accountDeletionHealthStatement(),
            compiled = statement.compile(tx);
          const explained = sql
            .raw<{ 'QUERY PLAN': { 'Execution Time': number; Plan: { 'Actual Rows': number } }[] }>(
              `EXPLAIN (ANALYZE,FORMAT JSON) ${compiled.sql}`,
            )
            .compile(tx);
          const result = await tx.executeQuery<{
            'QUERY PLAN': { 'Execution Time': number; Plan: { 'Actual Rows': number } }[];
          }>({ ...explained, parameters: compiled.parameters });
          const plan = result.rows[0]!['QUERY PLAN'][0]!;
          expect(plan['Execution Time']).toBeLessThanOrEqual(1500);
          expect(plan.Plan['Actual Rows']).toBe(8);
          for (let n = 0; n < 3; n++) {
            const sample = await new PostgresAccountDeletionHealthStore(tx).measure();
            for (const phase of ACCOUNT_DELETION_PHASES) {
              expect(sample.phases[phase].records).toBe(baseline.phases[phase].records + 2500);
              expect(sample.phases[phase].inconsistent).toBe(0);
            }
          }
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    const after = await health.measure();
    for (const phase of ACCOUNT_DELETION_PHASES)
      expect(after.phases[phase].records).toBe(baseline.phases[phase].records);
  });
});
