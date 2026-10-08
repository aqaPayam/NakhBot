import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportChat, createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 verified evidence/source checkpoint', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionCheckpointStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_source_checkpoint');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionCheckpointStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const rows = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function scene(leaseMs = 120000): Promise<{
    userId: string;
    recordId: string;
    shared: AccountDeletionLease;
    lease: AccountDeletionLease;
  }> {
    const fixture = await createDeletionFixture(database),
      shared = await claim();
    await store.finishShared(shared);
    return { ...fixture, shared, lease: await claim(leaseMs) };
  }
  async function state(id: string): Promise<{
    phase: string;
    checkpoint_version: number;
    product_purged_at: Date | null;
    completed_at: Date | null;
    reactivation_allowed: boolean;
  }> {
    return (
      await sql<{
        phase: string;
        checkpoint_version: number;
        product_purged_at: Date | null;
        completed_at: Date | null;
        reactivation_allowed: boolean;
      }>`
      SELECT phase,checkpoint_version,product_purged_at,completed_at,reactivation_allowed
      FROM identity.account_deletion_records WHERE id=${id}::uuid`.execute(database)
    ).rows[0]!;
  }
  async function receipts(id: string): Promise<number> {
    return (
      await sql`SELECT 1 FROM identity.account_deletion_phase_receipts
      WHERE deletion_record_id=${id}::uuid AND completed_phase='evidence_capture'`.execute(database)
    ).rows.length;
  }
  it('advances exactly once under twenty requests, preserves original shared replay and denies forged future progress', async () => {
    const item = await scene();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.finishEvidence(item.lease)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      results.every((result) => result.phase === 'product_data' && result.checkpointVersion === 3),
    ).toBe(true);
    expect(await receipts(item.recordId)).toBe(1);
    expect(await state(item.recordId)).toEqual({
      phase: 'product_data',
      checkpoint_version: 3,
      product_purged_at: null,
      completed_at: null,
      reactivation_allowed: false,
    });
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', item.recordId)
      .execute();
    expect(await store.finishEvidence(item.lease)).toEqual({
      phase: 'product_data',
      checkpointVersion: 3,
      replayed: true,
    });
    expect(await store.finishShared(item.shared)).toEqual({
      phase: 'evidence_capture',
      checkpointVersion: 2,
      replayed: true,
    });
    for (const forged of [
      { ...item.lease, userId: randomUUID() },
      { ...item.lease, leaseOwner: randomUUID() },
      { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
      { ...item.lease, phase: 'product_data' as const, checkpointVersion: 3 },
    ])
      await expect(store.finishEvidence(forged)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      sql`UPDATE identity.account_deletion_records SET phase='media_objects',checkpoint_version=4
      WHERE id=${item.recordId}::uuid`.execute(database),
    ).rejects.toThrow();
    expect(await receipts(item.recordId)).toBe(1);
  });
  it.each(['audit', 'event', 'receipt', 'record', 'work'] as const)(
    'rolls back evidence progress when required %s is suppressed',
    async (kind) => {
      const item = await scene();
      const table =
        kind === 'audit'
          ? 'platform.audit_logs'
          : kind === 'event'
            ? 'platform.outbox_events'
            : kind === 'receipt'
              ? 'identity.account_deletion_phase_receipts'
              : kind === 'record'
                ? 'identity.account_deletion_records'
                : 'identity.account_deletion_work';
      const condition =
        kind === 'audit' || kind === 'event'
          ? "NEW.event_type='account.deletion-phase-completed.v1'"
          : kind === 'receipt'
            ? "NEW.completed_phase='evidence_capture'"
            : "NEW.phase='product_data'";
      await sql
        .raw(
          `CREATE FUNCTION identity.m8_suppress_evidence_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER m8_suppress_evidence_checkpoint BEFORE ${kind === 'record' || kind === 'work' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_suppress_evidence_checkpoint()`,
        )
        .execute(database);
      try {
        await expect(store.finishEvidence(item.lease)).rejects.toThrow();
        expect(await receipts(item.recordId)).toBe(0);
        expect(await state(item.recordId)).toMatchObject({
          phase: 'evidence_capture',
          checkpoint_version: 2,
          product_purged_at: null,
          completed_at: null,
        });
      } finally {
        await sql.raw(`DROP TRIGGER m8_suppress_evidence_checkpoint ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_suppress_evidence_checkpoint()`.execute(database);
      }
      expect(await store.finishEvidence(item.lease)).toMatchObject({
        phase: 'product_data',
        replayed: false,
      });
    },
  );
  it('rolls back on commit-time expiry and resumes under a new generation', async () => {
    const item = await scene(1000);
    await expect(
      database.transaction().execute(async (tx) => {
        expect(
          await new PostgresAccountDeletionCheckpointStore(tx).finishEvidence(item.lease),
        ).toMatchObject({ phase: 'product_data' });
        await sql`SELECT pg_sleep(1.2)`.execute(tx);
      }),
    ).rejects.toThrow();
    expect(await receipts(item.recordId)).toBe(0);
    const fresh = await claim();
    expect(fresh.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
    await expect(store.finishEvidence(item.lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.finishEvidence(fresh)).toMatchObject({
      phase: 'product_data',
      replayed: false,
    });
  });
  it('checks expiry after waiting for the subject Account lock', async () => {
    const item = await scene(1000);
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((done) => {
        ready = done;
      }),
      gate = new Promise<void>((done) => {
        release = done;
      });
    const holder = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', item.userId)
        .forUpdate()
        .execute();
      ready();
      await gate;
    });
    await locked;
    const attempt = expect(store.finishEvidence(item.lease)).rejects.toMatchObject({
      code: 'conflict',
    });
    await sql`SELECT pg_sleep(1.2)`.execute(database);
    release();
    await holder;
    await attempt;
    expect(await receipts(item.recordId)).toBe(0);
    expect(await store.finishEvidence(await claim())).toMatchObject({ phase: 'product_data' });
  });
  it('reuses the one original shared-source proof when both participants delete independently', async () => {
    const template = await createReportUser(database, true);
    const profile = await database
      .selectFrom('profile.profiles')
      .selectAll()
      .where('user_id', '=', template)
      .executeTakeFirstOrThrow();
    async function active(owner: string): Promise<void> {
      await database
        .insertInto('profile.profiles')
        .values({ ...profile, id: randomUUID(), user_id: owner })
        .execute();
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${owner}::uuid`.execute(
        database,
      );
    }
    let second!: Awaited<ReturnType<typeof createDeletionFixture>>,
      chat!: Awaited<ReturnType<typeof createReportChat>>;
    const first = await createDeletionFixture(database, async (owner) => {
      await active(owner);
      second = await createDeletionFixture(database, async (other) => {
        await active(other);
        chat = await createReportChat(database, owner, other);
      });
    });
    const shared = await work.claimDue({ workerId: randomUUID(), limit: 2, leaseMs: 120000 });
    expect(shared).toHaveLength(2);
    for (const lease of shared) {
      await new PostgresAccountDeletionSharedStore(database).closeNext(lease);
      await store.finishShared(lease);
    }
    const evidence = await work.claimDue({ workerId: randomUUID(), limit: 2, leaseMs: 120000 });
    expect(evidence).toHaveLength(2);
    const a = evidence.find((lease) => lease.userId === first.userId)!,
      b = evidence.find((lease) => lease.userId === second.userId)!;
    for (const lease of [a, b])
      expect(await new PostgresAccountDeletionProfileStore(database).archive(lease)).toEqual({
        archived: true,
      });
    expect(await store.finishEvidence(a)).toMatchObject({ waitingFor: 'chat_sources' });
    expect(await new PostgresAccountDeletionChatStore(database).archiveNext(b)).toMatchObject({
      archived: true,
    });
    expect(await store.finishEvidence(a)).toMatchObject({ waitingFor: 'match_sources' });
    expect(await new PostgresAccountDeletionMatchStore(database).archiveNext(b)).toMatchObject({
      archived: true,
    });
    for (const lease of [a, b])
      expect(await store.finishEvidence(lease)).toEqual({
        phase: 'product_data',
        checkpointVersion: 3,
        replayed: false,
      });
    const proofs = (
      await sql<{
        deletion_record_id: string;
      }>`SELECT deletion_record_id FROM identity.account_deletion_match_receipts WHERE match_id=${chat.matchId}::uuid`.execute(
        database,
      )
    ).rows;
    expect(proofs).toEqual([{ deletion_record_id: second.recordId }]);
  });
});
