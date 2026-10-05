import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportFixtureAdmin, createRetainedReportPhoto } from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import {
  createPostgresM7OperationalHealthHandlers,
  PostgresM7OperationalHealthStore,
} from './moderation-operational-health-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native operational health authority and metadata', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m7_health');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 5,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  it('uses verified native identity and all three current permission domains', async () => {
    const adminId = await createReportFixtureAdmin(database),
      fixture = await confirmationFixture(database, adminId);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const handlers = createPostgresM7OperationalHealthHandlers(
      database,
      fixture.tokens,
      fixture.key,
    );
    const query = { actor: fixture.actor, requestId: randomUUID() },
      token = await handlers.prepare.execute(query, fixture.actor);
    const samples = await Promise.all(
      Array.from({ length: 5 }, () => handlers.get.execute({ ...query, ...token }, fixture.actor)),
    );
    expect(
      samples.every(
        (s) => s.appealUniquenessMismatchCount === 0 && s.oldestPendingReportAgeSeconds === 0,
      ),
    ).toBe(true);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .execute();
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'moderator',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    await expect(handlers.get.execute({ ...query, ...token }, fixture.actor)).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(handlers.prepare.execute(query, fixture.actor)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      database
        .updateTable('administration.admin_user_roles')
        .set({ revoked_at: null, revoked_by_admin_id: null })
        .where('admin_user_id', '=', adminId)
        .where('role_code', '=', 'super_admin')
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    // Revocation is immutable. Disable a separate currently authorized identity.
    const enabledId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: enabledId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const enabled = await confirmationFixture(database, enabledId);
    const enabledHandlers = createPostgresM7OperationalHealthHandlers(
      database,
      enabled.tokens,
      enabled.key,
    );
    const enabledQuery = { actor: enabled.actor, requestId: randomUUID() };
    const enabledToken = await enabledHandlers.prepare.execute(enabledQuery, enabled.actor);
    await expect(
      enabledHandlers.get.execute({ ...enabledQuery, ...enabledToken }, enabled.actor),
    ).resolves.toMatchObject({ appealUniquenessMismatchCount: 0 });
    await database
      .updateTable('administration.admin_users')
      .set({ is_active: false, disabled_at: new Date() })
      .where('id', '=', enabledId)
      .execute();
    await expect(
      enabledHandlers.get.execute({ ...enabledQuery, ...enabledToken }, enabled.actor),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('measures whole-second ages and current capture metadata, clearing repaired drift', async () => {
    const fixture = await createRetainedReportPhoto(database),
      store = new PostgresM7OperationalHealthStore(database);
    const snapshot = await database
      .selectFrom('moderation.report_snapshots')
      .selectAll()
      .where('report_evidence_id', '=', fixture.evidenceId)
      .executeTakeFirstOrThrow();
    const healthy = await store.measure();
    expect(Object.keys(healthy)).toHaveLength(8);
    expect(healthy.snapshotIntegrityFailureCount).toBe(0);
    expect(Number.isSafeInteger(healthy.oldestPendingReportAgeSeconds)).toBe(true);
    expect(healthy.oldestInReviewAgeSeconds).toBe(0);
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .deleteFrom('moderation.report_snapshots')
          .where('id', '=', snapshot.id)
          .execute();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });
    try {
      const broken = await store.measure();
      expect(broken.snapshotIntegrityFailureCount).toBe(1);
      expect(broken.supportLimitMismatchCount).toBe(0);
      expect(broken.appealUniquenessMismatchCount).toBe(0);
    } finally {
      await database.insertInto('moderation.report_snapshots').values(snapshot).execute();
    }
    expect((await store.measure()).snapshotIntegrityFailureCount).toBe(0);
    expect(
      await database.selectFrom('billing.reconciliation_runs').select('id').execute(),
    ).toHaveLength(0);
  });
});
