import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 durable fenced deletion work', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let store: PostgresAccountDeletionWorkStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_work');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
    store = new PostgresAccountDeletionWorkStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    // Isolate scheduling among scenarios without removing durable history.
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  async function claim(leaseMs = 10000, workerId = randomUUID()): Promise<AccountDeletionLease> {
    const rows = await store.claimDue({ workerId, limit: 1, leaseMs });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function settings(userId: string): Promise<number> {
    return (
      await database
        .selectFrom('identity.user_settings')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute()
    ).length;
  }
  it('twenty workers obtain one owning fence and preserve the deletion checkpoint', async () => {
    const fixture = await createDeletionFixture(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 }),
      ),
    );
    const leases = results.flat();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      deletionRecordId: fixture.recordId,
      userId: fixture.userId,
      phase: 'shared_closure',
      checkpointVersion: 1,
      leaseGeneration: 1,
      attemptCount: 1,
    });
    expect(Object.keys(leases[0]!).sort()).toEqual([
      'attemptCount',
      'checkpointVersion',
      'deletionRecordId',
      'leaseExpiresAt',
      'leaseGeneration',
      'leaseOwner',
      'phase',
      'userId',
    ]);
    expect(await store.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 })).toEqual([]);
  });
  it('skips a locked due row and claims bounded independent work', async () => {
    const first = await createDeletionFixture(database),
      second = await createDeletionFixture(database);
    await database.transaction().execute(async (tx) => {
      await sql`SELECT deletion_record_id FROM identity.account_deletion_work WHERE deletion_record_id=${first.recordId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const rows = await store.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 });
      expect(rows.map((row) => row.deletionRecordId)).toEqual([second.recordId]);
    });
    expect((await claim()).deletionRecordId).toBe(first.recordId);
  });
  it('serializes ordinary batches and rolls back a failed batch without losing mandatory work', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim();
    const failure = new Error('Deletion batch fixture failure');
    await expect(
      store.withLease(lease, async (tx) => {
        await tx
          .deleteFrom('identity.user_settings')
          .where('user_id', '=', fixture.userId)
          .execute();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await settings(fixture.userId)).toBe(1);
    const changes = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.withLease(lease, async (tx, scope) => {
          expect(scope.userId).toBe(fixture.userId);
          const result = await tx
            .deleteFrom('identity.user_settings')
            .where('user_id', '=', scope.userId)
            .executeTakeFirst();
          return Number(result.numDeletedRows);
        }),
      ),
    );
    expect(changes.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(await settings(fixture.userId)).toBe(0);
    expect(
      (
        await sql<{
          phase: string;
          checkpoint_version: number;
        }>`SELECT phase,checkpoint_version FROM identity.account_deletion_records WHERE id=${fixture.recordId}::uuid`.execute(
          database,
        )
      ).rows[0],
    ).toEqual({ phase: 'shared_closure', checkpoint_version: 1 });
  });
  it('renews monotonically and releases once across competing settlements', async () => {
    await createDeletionFixture(database);
    const lease = await claim(30000);
    const renewals = await Promise.all(Array.from({ length: 20 }, () => store.renew(lease, 10000)));
    for (const renewed of renewals) {
      expect(renewed.leaseGeneration).toBe(1);
      expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
        lease.leaseExpiresAt.getTime(),
      );
    }
    const releases = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.release(lease)),
    );
    expect(releases.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(releases.filter((row) => row.status === 'rejected')).toHaveLength(19);
    const next = await claim();
    expect(next.leaseGeneration).toBe(2);
    expect(next.attemptCount).toBe(2);
  });
  it('recovers after expiry with a new generation even when the same worker ID returns', async () => {
    const fixture = await createDeletionFixture(database),
      worker = randomUUID(),
      old = await claim(1000, worker);
    await sql`SELECT pg_sleep(1.1)`.execute(database);
    await expect(
      sql`UPDATE identity.account_deletion_work SET lease_expires_at=clock_timestamp()+interval '10 seconds'
      WHERE deletion_record_id=${fixture.recordId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    const current = await claim(10000, worker);
    expect(current.leaseOwner).toBe(old.leaseOwner);
    expect(current.leaseGeneration).toBe(2);
    let called = false;
    await expect(
      store.withLease(old, () => {
        called = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(called).toBe(false);
    for (const op of [
      () => store.renew(old, 10000),
      () => store.release(old),
      () => store.retry(old, 'deletion_phase_failed', 1),
    ])
      await expect(op()).rejects.toMatchObject({ status: 409 });
    expect(await settings(fixture.userId)).toBe(1);
    await store.withLease(current, () => Promise.resolve());
  });
  it('rolls back a batch that expires while its row lock prevents another claimant', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim(1000);
    await expect(
      store.withLease(lease, async (tx) => {
        await tx
          .deleteFrom('identity.user_settings')
          .where('user_id', '=', fixture.userId)
          .execute();
        await sql`SELECT pg_sleep(1.1)`.execute(tx);
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await settings(fixture.userId)).toBe(1);
    expect((await claim()).leaseGeneration).toBe(2);
  });
  it('retries atomically with fixed errors and a database-clock delay after transport loss', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim();
    await store.retry(lease, 'deletion_evidence_pending', 1);
    const result = (
      await sql<{
        record_error: string;
        work_error: string;
        due: boolean;
        owner: string | null;
        generation: number;
      }>`
      SELECT record.last_error_code AS record_error,work.last_error_code AS work_error,
        work.available_at>clock_timestamp() AS due,work.lease_owner AS owner,work.lease_generation AS generation
      FROM identity.account_deletion_records record JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id
      WHERE record.id=${fixture.recordId}::uuid`.execute(database)
    ).rows[0]!;
    expect(result).toEqual({
      record_error: 'deletion_evidence_pending',
      work_error: 'deletion_evidence_pending',
      due: true,
      owner: null,
      generation: 1,
    });
    expect(await store.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 })).toEqual([]);
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', fixture.recordId)
      .execute();
    await sql`SELECT pg_sleep(1.1)`.execute(database);
    const restarted = new PostgresAccountDeletionWorkStore(database),
      next = (await restarted.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 }))[0]!;
    expect(next.leaseGeneration).toBe(2);
    await restarted.release(next);
    const cleared = (
      await sql<{
        record_error: null;
        work_error: null;
      }>`SELECT record.last_error_code AS record_error,work.last_error_code AS work_error
      FROM identity.account_deletion_records record JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id WHERE record.id=${fixture.recordId}::uuid`.execute(
        database,
      )
    ).rows[0];
    expect(cleared).toEqual({ record_error: null, work_error: null });
  });
  it('rolls back retry metadata when the owning lease cannot be cleared', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim();
    await sql`CREATE FUNCTION identity.m8_test_suppress_lease_clear() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.lease_owner IS NULL AND OLD.lease_owner IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_test_suppress_lease_clear BEFORE UPDATE ON identity.account_deletion_work
      FOR EACH ROW EXECUTE FUNCTION identity.m8_test_suppress_lease_clear()`.execute(database);
    try {
      await expect(store.retry(lease, 'deletion_phase_failed', 1)).rejects.toMatchObject({
        status: 409,
      });
      const rows = (
        await sql<{
          error: string | null;
          owner: string;
          generation: number;
        }>`SELECT record.last_error_code AS error,
        work.lease_owner AS owner,work.lease_generation AS generation FROM identity.account_deletion_records record
        JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id WHERE record.id=${fixture.recordId}::uuid`.execute(
          database,
        )
      ).rows;
      expect(rows).toEqual([{ error: null, owner: lease.leaseOwner, generation: 1 }]);
      await store.withLease(lease, () => Promise.resolve());
    } finally {
      await sql`DROP TRIGGER m8_test_suppress_lease_clear ON identity.account_deletion_work`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.m8_test_suppress_lease_clear()`.execute(database);
    }
    await store.retry(lease, 'deletion_phase_failed', 1);
  });
  it('rechecks expiry after waiting behind an owning identity lock', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim(1000);
    let called = false,
      waiting: Promise<unknown> | undefined;
    await database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', fixture.userId)
        .forNoKeyUpdate()
        .execute();
      waiting = store
        .withLease(lease, () => {
          called = true;
          return Promise.resolve();
        })
        .catch((error: unknown) => error);
      await sql`SELECT pg_sleep(1.1)`.execute(tx);
    });
    expect(await waiting).toMatchObject({ status: 409 });
    expect(called).toBe(false);
    expect((await claim()).leaseGeneration).toBe(2);
  });
  it('rejects forged bindings, unbounded inputs and raw state changes that invent progress', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim();
    for (const damage of [
      { userId: randomUUID() },
      { leaseOwner: randomUUID() },
      { leaseGeneration: 2 },
      { checkpointVersion: 2 },
      { phase: 'evidence_capture' as const },
      { deletionRecordId: randomUUID() },
    ])
      await expect(
        store.withLease({ ...lease, ...damage }, () => Promise.resolve()),
      ).rejects.toMatchObject({ status: 409 });
    for (const input of [
      { limit: 0, leaseMs: 10000 },
      { limit: 51, leaseMs: 10000 },
      { limit: 1, leaseMs: 999 },
      { limit: 1, leaseMs: 120001 },
    ])
      await expect(store.claimDue({ workerId: randomUUID(), ...input })).rejects.toMatchObject({
        status: 409,
      });
    await expect(
      store.retry(lease, 'private-prose' as 'deletion_phase_failed', 1),
    ).rejects.toMatchObject({ status: 409 });
    await expect(store.retry(lease, 'deletion_phase_failed', 3601)).rejects.toMatchObject({
      status: 409,
    });
    for (const statement of [
      sql`UPDATE identity.account_deletion_work SET lease_generation=lease_generation+2 WHERE deletion_record_id=${fixture.recordId}::uuid`,
      sql`UPDATE identity.account_deletion_work SET lease_owner=${randomUUID()}::uuid WHERE deletion_record_id=${fixture.recordId}::uuid`,
      sql`UPDATE identity.account_deletion_work SET attempt_count=0 WHERE deletion_record_id=${fixture.recordId}::uuid`,
      sql`UPDATE identity.account_deletion_work SET phase='evidence_capture',checkpoint_version=2 WHERE deletion_record_id=${fixture.recordId}::uuid`,
    ])
      await expect(statement.execute(database)).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`UPDATE identity.account_deletion_records SET phase='evidence_capture',checkpoint_version=2 WHERE id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`UPDATE identity.account_deletion_records SET last_error_code='deletion_phase_failed' WHERE id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await store.withLease(lease, () => Promise.resolve());
  });
});
