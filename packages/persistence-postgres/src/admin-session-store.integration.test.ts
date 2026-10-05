import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type VerifiedAdminMfaProof, type AdminSessionService } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import { createPostgresAdminSessions } from './admin-session-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native durable admin sessions', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_admin_sessions');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 20,
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
  async function fixture(): Promise<
    Readonly<{
      adminId: string;
      actor: { kind: 'user'; userId: string };
      telegramUserId: string;
      service: AdminSessionService;
      issue: () => ReturnType<AdminSessionService['issue']>;
      next: () => void;
    }>
  > {
    const adminId = await createReportFixtureAdmin(database);
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
    const admin = await database
      .selectFrom('administration.admin_users')
      .selectAll()
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    const actor = { kind: 'user' as const, userId: admin.user_id },
      telegramUserId = admin.telegram_user_id;
    let proof: VerifiedAdminMfaProof = {
      actorUserId: actor.userId,
      telegramUserId,
      proofId: randomUUID(),
      verifiedAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 240000),
    };
    const service = createPostgresAdminSessions(database, { verify: () => Promise.resolve(proof) });
    return {
      adminId,
      actor,
      telegramUserId,
      service,
      issue: () =>
        service.issue({
          actor,
          telegramUserId,
          requestId: randomUUID(),
          proof: 'synthetic-protected-factor',
        }),
      next: () => {
        proof = { ...proof, proofId: randomUUID() };
      },
    };
  }
  it('admits one concurrent proof, stores hashes only, and audits idempotent owner revocation', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => f.issue()));
    const success = outcomes.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof f.issue>>> =>
        r.status === 'fulfilled',
    );
    expect(success).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(19);
    const token = success[0]!.value.adminSessionToken;
    const rows = (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM administration.admin_sessions WHERE admin_user_id=${f.adminId}::uuid`.execute(
        database,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain('synthetic-protected-factor');
    expect(await f.service.authenticate({ bearerToken: token, audience: 'admin' })).toEqual({
      kind: 'admin',
      userId: f.actor.userId,
    });
    expect((await f.service.current(f.telegramUserId))?.actor.userId).toBe(f.actor.userId);
    await f.service.revoke({
      actor: { kind: 'admin', userId: randomUUID() },
      adminSessionToken: token,
      requestId: randomUUID(),
    });
    expect(await f.service.authenticate({ bearerToken: token, audience: 'admin' })).toBeDefined();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        f.service.revoke({
          actor: { ...f.actor, kind: 'admin' },
          adminSessionToken: token,
          requestId: randomUUID(),
        }),
      ),
    );
    expect(await f.service.authenticate({ bearerToken: token, audience: 'admin' })).toBeUndefined();
    expect(await f.service.current(f.telegramUserId)).toBeUndefined();
    const audits = await database
      .selectFrom('platform.audit_logs')
      .select(['event_type', 'metadata'])
      .where('actor_admin_id', '=', f.adminId)
      .orderBy('occurred_at')
      .execute();
    expect(audits.map((a) => a.event_type)).toEqual([
      'administration.session-issued.v1',
      'administration.session-revoked.v1',
    ]);
    expect(audits.every((a) => JSON.stringify(a.metadata) === '{}')).toBe(true);
    await expect(
      sql`DELETE FROM administration.admin_sessions WHERE admin_user_id=${f.adminId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('supersedes earlier grants and never revives them after logout or MFA expiry', async () => {
    const f = await fixture(),
      first = await f.issue();
    f.next();
    const second = await f.issue();
    expect(
      await f.service.authenticate({ bearerToken: first.adminSessionToken, audience: 'admin' }),
    ).toBeUndefined();
    expect(
      await f.service.authenticate({ bearerToken: second.adminSessionToken, audience: 'admin' }),
    ).toBeDefined();
    await f.service.revoke({
      actor: { ...f.actor, kind: 'admin' },
      adminSessionToken: second.adminSessionToken,
      requestId: randomUUID(),
    });
    expect(await f.service.current(f.telegramUserId)).toBeUndefined();
    f.next();
    const third = await f.issue();
    await expect(
      sql`UPDATE administration.admin_sessions SET mfa_expires_at=mfa_expires_at+interval '1 second' WHERE admin_user_id=${f.adminId}::uuid AND revoked_at IS NULL`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE administration.admin_sessions SET issued_at=issued_at-interval '10 minutes',expires_at=expires_at-interval '10 minutes',mfa_verified_at=mfa_verified_at-interval '10 minutes',mfa_expires_at=mfa_expires_at-interval '10 minutes' WHERE admin_user_id=${f.adminId}::uuid AND revoked_at IS NULL`.execute(
        tx,
      );
    });
    expect(
      await f.service.authenticate({ bearerToken: third.adminSessionToken, audience: 'admin' }),
    ).toBeUndefined();
    expect(await f.service.current(f.telegramUserId)).toBeUndefined();
    expect(
      (
        await sql<{
          role: string;
        }>`SELECT current_setting('session_replication_role') AS role`.execute(database)
      ).rows[0]?.role,
    ).toBe('origin');
  });
  it('rejects disabled/re-enabled admin versions and revoked current roles', async () => {
    const f = await fixture(),
      credential = await f.issue();
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`updated_at+interval '1 millisecond'`,
        updated_at: sql<Date>`updated_at+interval '1 millisecond'`,
        version: sql<number>`version+1`,
      })
      .where('id', '=', f.adminId)
      .execute();
    expect(
      await f.service.authenticate({
        bearerToken: credential.adminSessionToken,
        audience: 'admin',
      }),
    ).toBeUndefined();
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: true,
        disabled_at: null,
        updated_at: sql<Date>`updated_at+interval '1 millisecond'`,
        version: sql<number>`version+1`,
      })
      .where('id', '=', f.adminId)
      .execute();
    expect(
      await f.service.authenticate({
        bearerToken: credential.adminSessionToken,
        audience: 'admin',
      }),
    ).toBeUndefined();
    f.next();
    const replacement = await f.issue();
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
      .where('admin_user_id', '=', f.adminId)
      .execute();
    expect(
      await f.service.authenticate({
        bearerToken: replacement.adminSessionToken,
        audience: 'admin',
      }),
    ).toBeUndefined();
    expect(await f.service.current(f.telegramUserId)).toBeUndefined();
    f.next();
    await expect(f.issue()).rejects.toMatchObject({ status: 401 });
  });
  it('rolls back supersession and proof consumption when the required issue audit fails', async () => {
    const f = await fixture(),
      previous = await f.issue();
    f.next();
    await sql`CREATE FUNCTION administration.fail_session_issue_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='administration.session-issued.v1' THEN RAISE EXCEPTION 'required security audit failed' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER fail_session_issue_test BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION administration.fail_session_issue_test()`.execute(
      database,
    );
    try {
      await expect(f.issue()).rejects.toMatchObject({ code: '23514' });
      expect(
        await f.service.authenticate({
          bearerToken: previous.adminSessionToken,
          audience: 'admin',
        }),
      ).toBeDefined();
      expect(
        (
          await sql<{
            count: string;
          }>`SELECT count(*)::text AS count FROM administration.admin_sessions WHERE admin_user_id=${f.adminId}::uuid`.execute(
            database,
          )
        ).rows[0]?.count,
      ).toBe('1');
    } finally {
      await sql`DROP TRIGGER fail_session_issue_test ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION administration.fail_session_issue_test()`.execute(database);
    }
    const retried = await f.issue();
    expect(
      await f.service.authenticate({ bearerToken: retried.adminSessionToken, audience: 'admin' }),
    ).toBeDefined();
    expect(
      await f.service.authenticate({ bearerToken: previous.adminSessionToken, audience: 'admin' }),
    ).toBeUndefined();
  });
});
