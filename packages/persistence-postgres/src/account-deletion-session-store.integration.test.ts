import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';
import { PostgresAccountDeletionTransportStore } from './account-deletion-transport-store.js';
import { PostgresAccountDeletionReferencedLikeStore } from './account-deletion-referenced-like-store.js';
import { PostgresAccountDeletionLikeStore } from './account-deletion-like-store.js';
import { PostgresAccountDeletionFinancialStore } from './account-deletion-financial-store.js';
import { PostgresAccountDeletionOperationalStore } from './account-deletion-operational-store.js';
import { PostgresAccountDeletionSessionStore } from './account-deletion-session-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original Root session authority retirement', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionSessionStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_root_sessions');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionSessionStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
      database,
    );
  });
  async function claim(): Promise<AccountDeletionLease> {
    const rows = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function scene(
    count = 1,
  ): Promise<{ userId: string; recordId: string; ids: string[]; lease: AccountDeletionLease }> {
    const ids: string[] = [];
    const item = await createDeletionFixture(database, async (userId) => {
      const sessions = new PostgresUserSessionStore(database);
      for (let n = 0; n < count; n++)
        ids.push((await sessions.issue({ userId, productEpoch: 0 }, randomUUID()))!.id);
    });
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    const shared = await claim();
    while ((await new PostgresAccountDeletionSharedStore(database).closeNext(shared)).hasMore) {
      /* bounded */
    }
    await checkpoints.finishShared(shared);
    await checkpoints.finishEvidence(await claim());
    const product = await claim();
    while ((await new PostgresAccountDeletionProductStore(database).purgeNext(product)).hasMore) {
      /* bounded */
    }
    while ((await new PostgresAccountDeletionTransportStore(database).purgeNext(product)).hasMore) {
      /* bounded */
    }
    while (
      (await new PostgresAccountDeletionReferencedLikeStore(database).purgeNext(product)).hasMore
    ) {
      /* bounded */
    }
    while ((await new PostgresAccountDeletionLikeStore(database).purgeNext(product)).hasMore) {
      /* bounded */
    }
    await new PostgresAccountDeletionFinancialStore(database).prepareCreditEpoch(product);
    await new PostgresAccountDeletionOperationalStore(database).cancelNext(product);
    expect(await checkpoints.finishProduct(product)).toMatchObject({ phase: 'media_objects' });
    expect(await checkpoints.finishMedia(await claim())).toMatchObject({
      phase: 'ephemeral_access',
    });
    return { ...item, ids, lease: await claim() };
  }
  async function authority(id: string): Promise<boolean> {
    return (
      await sql<{
        revoked: boolean;
      }>`SELECT identity.user_session_authority_revoked(${id}::uuid) AS revoked`.execute(database)
    ).rows[0]!.revoked;
  }
  it('independently revokes 205 original grants in bounded batches without granting completion', async () => {
    const { lease, ids } = await scene(205);
    expect(await store.verify(lease)).toEqual({ verified: false });
    expect(await authority(ids[0]!)).toBe(false);
    expect(
      await new PostgresUserSessionStore(database).current(
        { userId: lease.userId, productEpoch: 0 },
        ids[0]!,
      ),
    ).toBeUndefined();
    expect(await store.revokeNext(lease)).toEqual({ revoked: 100, hasMore: true });
    expect(await store.revokeNext(lease)).toEqual({ revoked: 100, hasMore: true });
    expect(await store.revokeNext(lease)).toEqual({ revoked: 5, hasMore: false });
    expect(await store.verify(lease)).toEqual({ verified: true });
    expect(
      (
        await sql`SELECT phase,checkpoint_version,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      {
        phase: 'ephemeral_access',
        checkpoint_version: 5,
        completed_at: null,
        reactivation_allowed: false,
      },
    ]);
    expect(
      (
        await sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM identity.account_deletion_session_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows[0]!.count,
    ).toBe(3);
  });
  it('serializes twenty retries into one immutable revocation and retains historical proof after lease replacement', async () => {
    const { lease, ids } = await scene();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.revokeNext(lease)));
    expect(results.reduce((sum, row) => sum + row.revoked, 0)).toBe(1);
    expect(await authority(ids[0]!)).toBe(true);
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
      database,
    );
    expect(await authority(ids[0]!)).toBe(true);
    const replacement = await claim();
    expect(replacement.leaseGeneration).toBeGreaterThan(lease.leaseGeneration);
    await expect(store.verify(lease)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      sql`DELETE FROM identity.account_deletion_session_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it.each(['user', 'root', 'worker', 'generation', 'phase', 'version'] as const)(
    'rejects changed %s authority',
    async (field) => {
      const { lease } = await scene();
      const changed: AccountDeletionLease = { ...lease };
      const replacements = {
        user: { userId: randomUUID() },
        root: { deletionRecordId: randomUUID() },
        worker: { leaseOwner: randomUUID() },
        generation: { leaseGeneration: lease.leaseGeneration + 1 },
        phase: { phase: 'media_objects' as const },
        version: { checkpointVersion: 4 },
      };
      await expect(store.revokeNext({ ...changed, ...replacements[field] })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await store.verify(lease)).toEqual({ verified: false });
    },
  );
  it.each([0, 101, 1.5, NaN])('rejects invalid batch limit %s before mutation', async (limit) => {
    const { lease } = await scene();
    await expect(store.revokeNext(lease, limit)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.verify(lease)).toEqual({ verified: false });
  });
  it.each(['audit', 'receipt'] as const)(
    'rolls back suppressed required %s and safely retries',
    async (kind) => {
      const { lease, ids } = await scene();
      const table =
        kind === 'audit' ? 'platform.audit_logs' : 'identity.account_deletion_session_receipts';
      const predicate =
        kind === 'audit' ? "NEW.event_type='identity.user-session-root-revoked.v1'" : 'true';
      await sql
        .raw(
          `CREATE FUNCTION public.suppress_session_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER zz_suppress_session_proof BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.suppress_session_proof()`,
        )
        .execute(database);
      try {
        await expect(store.revokeNext(lease)).rejects.toBeDefined();
      } finally {
        await sql.raw(`DROP TRIGGER zz_suppress_session_proof ON ${table}`).execute(database);
        await sql`DROP FUNCTION public.suppress_session_proof()`.execute(database);
      }
      expect(await authority(ids[0]!)).toBe(false);
      expect(await store.revokeNext(lease)).toEqual({ revoked: 1, hasMore: false });
    },
  );
  it('rolls back when the native lease expires before deferred proof validation', async () => {
    const { lease, ids } = await scene();
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL WHERE deletion_record_id=${lease.deletionRecordId}::uuid`.execute(
      database,
    );
    const short = (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 1000 }))[0]!;
    await sql`CREATE FUNCTION public.delay_session_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER zz_delay_session_proof AFTER INSERT ON identity.account_deletion_session_receipts FOR EACH ROW EXECUTE FUNCTION public.delay_session_proof()`.execute(
      database,
    );
    try {
      await expect(store.revokeNext(short)).rejects.toBeDefined();
    } finally {
      await sql`DROP TRIGGER zz_delay_session_proof ON identity.account_deletion_session_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION public.delay_session_proof()`.execute(database);
    }
    expect(await authority(ids[0]!)).toBe(false);
    const replacement = await claim();
    expect(await store.revokeNext(replacement)).toEqual({ revoked: 1, hasMore: false });
  });
  it('does not grant proof to a substituted source audit, even with a valid stored receipt', async () => {
    const { lease, ids } = await scene();
    await store.revokeNext(lease);
    await database.transaction().execute(async (tx) => {
      await sql`ALTER TABLE platform.audit_logs DISABLE TRIGGER USER`.execute(tx);
      try {
        await sql`UPDATE platform.audit_logs SET metadata=jsonb_set(metadata,'{productEpoch}','1'::jsonb) WHERE id=${ids[0]}::uuid`.execute(
          tx,
        );
      } finally {
        await sql`ALTER TABLE platform.audit_logs ENABLE TRIGGER USER`.execute(tx);
      }
    });
    expect(await authority(ids[0]!)).toBe(false);
    await expect(store.verify(lease)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe.skipIf(url === undefined)('M8 session authority migration provenance', () => {
  it.each(['valid', 'invalid', 'invented_root'] as const)(
    'upgrades populated 134 only with original provenance: %s',
    async (mode) => {
      const isolated = await createIsolatedTestDatabase(url!, 'm8_session_upgrade');
      const directory = await mkdtemp(join(tmpdir(), 'm8-session-upgrade-'));
      let database: NakhDatabase | undefined;
      try {
        for (const name of await readdir(resolve('migrations'))) {
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(name) && Number(name.slice(0, 6)) <= 134)
            await copyFile(resolve('migrations', name), join(directory, name));
        }
        await runMigrations(isolated.url, directory);
        database = createDatabase({
          url: isolated.url,
          poolMax: 2,
          statementTimeoutMs: 30000,
          lockTimeoutMs: 10000,
        });
        let id = '';
        await createDeletionFixture(database, async (userId) => {
          id = (await new PostgresUserSessionStore(database!).issue(
            { userId, productEpoch: 0 },
            randomUUID(),
          ))!.id;
        });
        if (mode !== 'valid') {
          await database.transaction().execute(async (tx) => {
            await sql`ALTER TABLE platform.audit_logs DISABLE TRIGGER USER`.execute(tx);
            try {
              if (mode === 'invalid')
                await sql`UPDATE platform.audit_logs SET metadata=metadata||'{"unknown":"content"}'::jsonb WHERE id=${id}::uuid`.execute(
                  tx,
                );
              else
                await sql`UPDATE platform.audit_logs SET event_type='identity.user-session-root-revoked.v1' WHERE id=${id}::uuid`.execute(
                  tx,
                );
            } finally {
              await sql`ALTER TABLE platform.audit_logs ENABLE TRIGGER USER`.execute(tx);
            }
          });
        }
        const before = (
          await sql`SELECT * FROM platform.audit_logs WHERE id=${id}::uuid`.execute(database)
        ).rows;
        if (mode === 'valid') {
          expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([
            '000135_m8_deletion_sessions.sql',
          ]);
          await verifyMigrations(isolated.url, resolve('migrations/verify'));
          expect(
            (
              await sql<{
                epoch: number;
              }>`SELECT identity.user_session_epoch(${id}::uuid) AS epoch`.execute(database)
            ).rows[0]!.epoch,
          ).toBe(0);
        } else {
          await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toMatchObject({
            code: '55000',
          });
          expect(
            (
              await sql<{
                name: string | null;
              }>`SELECT to_regclass('identity.account_deletion_session_receipts')::text AS name`.execute(
                database,
              )
            ).rows[0]!.name,
          ).toBeNull();
        }
        expect(
          (await sql`SELECT * FROM platform.audit_logs WHERE id=${id}::uuid`.execute(database))
            .rows,
        ).toEqual(before);
      } finally {
        await database?.destroy();
        await isolated.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
