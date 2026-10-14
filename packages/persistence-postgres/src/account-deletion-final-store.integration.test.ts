import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RunAccountDeletionBatchHandler,
  ExecuteAccountDeletionMedia,
  ExecuteAccountDeletionEphemeral,
  type AccountDeletionMediaObjects,
  type AccountDeletionBatchResult,
} from '@nakh/application';
import type {
  AccountDeletionLease,
  DeletionEphemeralOperation,
  DeletionEphemeralObservation,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createFinalDeletionFixture } from './testing/final-deletion-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionPhaseExecutor } from './account-deletion-phase-executor.js';
import { PostgresAccountDeletionMediaStore } from './account-deletion-media-store.js';
import { PostgresAccountDeletionSessionStore } from './account-deletion-session-store.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 fresh final verification and atomic completion', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    store: PostgresAccountDeletionEphemeralStore,
    work: PostgresAccountDeletionWorkStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_final_verification');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    store = new PostgresAccountDeletionEphemeralStore(database, 'm8-native-final', 'a'.repeat(64));
    work = new PostgresAccountDeletionWorkStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
  });
  function empty(op: DeletionEphemeralOperation): DeletionEphemeralObservation {
    return {
      cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
      more: false,
      found: 0,
    };
  }
  async function pages(lease: AccountDeletionLease): Promise<void> {
    for (let n = 0; n < 20; n++) {
      const next = await store.claimNext(lease);
      if (next.done) return;
      expect(next.operation).toBeDefined();
      await store.complete(lease, next.operation!.id, empty(next.operation!));
    }
    throw new Error('Fresh final verification did not converge');
  }
  async function state(lease: AccountDeletionLease): Promise<Record<string, unknown>> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT phase,checkpoint_version,completed_at,product_purged_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
        database,
      )
    ).rows[0]!;
  }
  it('runs real admission through every native checkpoint using bounded polls and independent final verification', async () => {
    const item = await createDeletionFixture(database);
    const unreachable = (): Promise<never> => {
      return Promise.reject(
        new Error('Unexpected media provider call for an account without assets'),
      );
    };
    const objects: AccountDeletionMediaObjects = {
      list: unreachable,
      get: unreachable,
      putPrivate: unreachable,
      delete: unreachable,
      head: unreachable,
    };
    const media = new ExecuteAccountDeletionMedia(
      new PostgresAccountDeletionMediaStore(database, 'test'),
      objects,
      { purge: unreachable },
      'test',
    );
    // Provider observations are native fixtures; real Redis composition is tested
    // separately. No production provider absence or operator drain is asserted.
    const ephemeral = new ExecuteAccountDeletionEphemeral(
      store,
      new PostgresAccountDeletionSessionStore(database),
      {
        namespaceHash: store.namespaceHash,
        execute: async (op, guard) => {
          await guard();
          return empty(op);
        },
      },
    );
    const executor = new PostgresAccountDeletionPhaseExecutor(
      database,
      {},
      media,
      ephemeral,
      'test',
    );
    const handler = new RunAccountDeletionBatchHandler(work, executor, randomUUID());
    const results: AccountDeletionBatchResult[] = [];
    try {
      for (let n = 0; n < 100; n++) {
        const result = await handler.execute();
        results.push(result);
        expect(['progress', 'advanced', 'completed']).toContain(result.outcome);
        if (result.outcome === 'completed') break;
      }
    } finally {
      await handler.close();
    }
    expect(results.at(-1)).toEqual({ outcome: 'completed', phase: 'verification' });
    expect(results.filter((r) => r.outcome === 'advanced').map((r) => r.phase)).toEqual([
      'shared_closure',
      'evidence_capture',
      'product_data',
      'media_objects',
      'ephemeral_access',
      'retention_manifest',
    ]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 7 }]);
    expect(
      (
        await sql`SELECT phase,checkpoint_version,reactivation_allowed FROM identity.account_deletion_records WHERE id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ phase: 'completed', checkpoint_version: 8, reactivation_allowed: false }]);
  });
  it('requires a second six-stage cycle and preserves original reconciliation bytes and validity', async () => {
    const { lease } = await createFinalDeletionFixture(database);
    const historical = await sql<
      Record<string, unknown>
    >`SELECT * FROM platform.audit_logs WHERE subject_id=${lease.deletionRecordId}::uuid ORDER BY id`.execute(
      database,
    );
    expect(await store.finish(lease)).toEqual({ completed: false });
    await pages(lease);
    expect(await store.finish(lease)).toEqual({ completed: true });
    for (const row of historical.rows) {
      expect(
        (await sql`SELECT * FROM platform.audit_logs WHERE id=${row.id}::uuid`.execute(database))
          .rows,
      ).toEqual([row]);
    }
    expect(
      (
        await sql`SELECT identity.ephemeral_reconciliation_valid(${lease.deletionRecordId}::uuid,verified_at) AS valid FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='ephemeral_access'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
    const final = await state(lease);
    expect(final).toMatchObject({
      phase: 'completed',
      checkpoint_version: 8,
      reactivation_allowed: false,
    });
    expect(final.completed_at).not.toBeNull();
    expect(final.product_purged_at).toEqual(final.completed_at);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 12 }]);
    await expect(
      sql`UPDATE identity.account_deletion_records SET reactivation_allowed=true WHERE id=${lease.deletionRecordId}::uuid`.execute(
        database,
      ),
    ).rejects.toBeDefined();
  });
  it('upgrades a populated phase-seven manifest without rewriting proof or inventing completion', async () => {
    const old = await createIsolatedTestDatabase(url!, 'm8_final_upgrade');
    const directory = await mkdtemp(join(tmpdir(), 'nakh-m8-final-upgrade-'));
    let previous: NakhDatabase | undefined;
    try {
      for (const name of await readdir(resolve('migrations'))) {
        if (/^\d{6}.*\.sql$/u.test(name) && Number(name.slice(0, 6)) <= 137)
          await copyFile(resolve('migrations', name), join(directory, name));
      }
      await runMigrations(old.url, directory);
      previous = createDatabase({
        url: old.url,
        poolMax: 4,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const { lease } = await createFinalDeletionFixture(previous);
      const snapshot = async (): Promise<Record<string, unknown>[]> =>
        (
          await sql<
            Record<string, unknown>
          >`SELECT jsonb_build_object('root',to_jsonb(r),'work',(SELECT to_jsonb(w) FROM identity.account_deletion_work w WHERE w.deletion_record_id=r.id),'manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM identity.data_retention_records m WHERE m.deletion_record_id=r.id),'pages',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.revision) FROM identity.account_deletion_ephemeral_pages p WHERE p.deletion_record_id=r.id),'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM platform.audit_logs a WHERE a.subject_id=r.id)) AS proof FROM identity.account_deletion_records r WHERE r.id=${lease.deletionRecordId}::uuid`.execute(
            previous!,
          )
        ).rows;
      const before = await snapshot();
      await runMigrations(old.url, resolve('migrations'));
      await verifyMigrations(old.url, resolve('migrations/verify'));
      expect(await snapshot()).toEqual(before);
      const fresh = new PostgresAccountDeletionEphemeralStore(
        previous,
        'm8-native-final',
        'a'.repeat(64),
      );
      expect(await fresh.finish(lease)).toEqual({ completed: false });
    } finally {
      await previous?.destroy();
      await old.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('serializes twenty final claims, observations and completion replays into one chain', async () => {
    const { lease } = await createFinalDeletionFixture(database);
    const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimNext(lease)));
    const operations = claims.flatMap((row) => (row.operation ? [row.operation] : []));
    expect(operations).toHaveLength(1);
    const op = operations[0]!;
    await Promise.all(Array.from({ length: 20 }, () => store.complete(lease, op.id, empty(op))));
    await pages(lease);
    expect(await Promise.all(Array.from({ length: 20 }, () => store.finish(lease)))).toEqual(
      Array.from({ length: 20 }, () => ({ completed: true })),
    );
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='verification'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('persists a provider finding and repeats verification before completing', async () => {
    const { lease } = await createFinalDeletionFixture(database);
    let op = (await store.claimNext(lease)).operation!;
    await store.complete(lease, op.id, empty(op));
    op = (await store.claimNext(lease)).operation!;
    expect(op.stage).toBe('owned_verify');
    await store.complete(lease, op.id, { cursor: '42', more: true, found: 1 });
    op = (await store.claimNext(lease)).operation!;
    expect(op.cursor).toBe('42');
    await store.complete(lease, op.id, empty(op));
    op = (await store.claimNext(lease)).operation!;
    expect(op.stage).toBe('owned_remove');
    expect(await store.finish(lease)).toEqual({ completed: false });
    await store.complete(lease, op.id, empty(op));
    await pages(lease);
    expect(await store.finish(lease)).toEqual({ completed: true });
  });
  it('fences a lost response and old generation while preserving durable intent history', async () => {
    let { lease } = await createFinalDeletionFixture(database);
    const old = lease,
      op = (await store.claimNext(lease)).operation!;
    await work.release(lease);
    lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
    await expect(store.complete(old, op.id, empty(op))).rejects.toBeDefined();
    const retry = (await store.claimNext(lease)).operation!;
    expect(retry.stage).toBe(op.stage);
    expect(retry.cursor).toEqual(op.cursor);
    expect(retry.id).not.toBe(op.id);
    await store.complete(lease, retry.id, empty(retry));
    await pages(lease);
    expect(await store.finish(lease)).toEqual({ completed: true });
    await expect(store.finish(old)).rejects.toBeDefined();
  });
  it.each(['manifest', 'username'] as const)(
    'independently rejects corrupted final %s state',
    async (kind) => {
      const { lease } = await createFinalDeletionFixture(database);
      await pages(lease);
      const table =
        kind === 'manifest' ? 'identity.data_retention_records' : 'identity.telegram_identities';
      // Deliberate privileged corruption in an isolated database tests independent
      // verification; normal application writes cannot bypass these triggers.
      await database.transaction().execute(async (tx) => {
        await sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`).execute(tx);
        try {
          if (kind === 'manifest')
            await sql`DELETE FROM identity.data_retention_records WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
              tx,
            );
          else
            await sql`UPDATE identity.telegram_identities SET username='corrupted' WHERE user_id=${lease.userId}::uuid`.execute(
              tx,
            );
        } finally {
          await sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER USER`).execute(tx);
        }
      });
      expect(await store.finish(lease)).toEqual({ completed: false });
      expect(await state(lease)).toMatchObject({
        phase: 'verification',
        completed_at: null,
        product_purged_at: null,
        reactivation_allowed: false,
      });
    },
  );
  it.each(['reconciliation', 'audit', 'event', 'receipt', 'root', 'work'] as const)(
    'rolls back suppressed final %s and permits a complete retry',
    async (kind) => {
      const { lease } = await createFinalDeletionFixture(database);
      await pages(lease);
      const table = {
        reconciliation: 'platform.audit_logs',
        audit: 'platform.audit_logs',
        event: 'platform.outbox_events',
        receipt: 'identity.account_deletion_phase_receipts',
        root: 'identity.account_deletion_records',
        work: 'identity.account_deletion_work',
      }[kind];
      const predicate =
        kind === 'reconciliation'
          ? "NEW.event_type='account.deletion-ephemeral-reverified.v1'"
          : kind === 'audit'
            ? "NEW.event_type='account.deletion-phase-completed.v1'"
            : 'true';
      await sql
        .raw(
          `CREATE FUNCTION public.suppress_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER zz_suppress_final BEFORE ${kind === 'root' || kind === 'work' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.suppress_final()`,
        )
        .execute(database);
      try {
        await expect(store.finish(lease)).rejects.toBeDefined();
      } finally {
        await sql.raw(`DROP TRIGGER zz_suppress_final ON ${table}`).execute(database);
        await sql`DROP FUNCTION public.suppress_final()`.execute(database);
      }
      expect(await state(lease)).toMatchObject({
        phase: 'verification',
        checkpoint_version: 7,
        completed_at: null,
        product_purged_at: null,
        reactivation_allowed: false,
      });
      expect(await store.finish(lease)).toEqual({ completed: true });
    },
  );
  describe('deferred native expiry with full recovery', () => {
    let preparedLease: AccountDeletionLease;
    // Keep the full native fixture in a separately bounded setup hook. The test's
    // unchanged 60s bound then covers expiry, rollback and fresh recovery, rather
    // than also counting all preceding phase 1..7 setup under concurrent CI load.
    beforeEach(async () => {
      preparedLease = (await createFinalDeletionFixture(database)).lease;
      await pages(preparedLease);
    });
    it('rolls back proof when a real native lease expires during deferred commit validation', async () => {
      let lease = preparedLease;
      await sql`CREATE SEQUENCE public.final_expiry_probe`.execute(database);
      await sql`CREATE FUNCTION public.delay_final_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('public.final_expiry_probe'); PERFORM pg_sleep(greatest(0,extract(epoch FROM NEW.lease_expires_at-clock_timestamp()))+0.1); RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE CONSTRAINT TRIGGER aa_final_expiry AFTER INSERT ON identity.account_deletion_phase_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.delay_final_proof()`.execute(
        database,
      );
      await work.release(lease);
      lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 }))[0]!;

      try {
        await expect(store.finish(lease)).rejects.toBeDefined();
        expect(
          (
            await sql<{
              is_called: boolean;
            }>`SELECT is_called FROM public.final_expiry_probe`.execute(database)
          ).rows[0]!.is_called,
        ).toBe(true);
      } finally {
        await sql`DROP TRIGGER aa_final_expiry ON identity.account_deletion_phase_receipts`.execute(
          database,
        );
        await sql`DROP FUNCTION public.delay_final_proof()`.execute(database);
        await sql`DROP SEQUENCE public.final_expiry_probe`.execute(database);
      }
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='verification'`.execute(
            database,
          )
        ).rows[0]!.count,
      ).toBe(0);
      lease = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      await pages(lease);
      expect(await store.finish(lease)).toEqual({ completed: true });
    });
  });
});
