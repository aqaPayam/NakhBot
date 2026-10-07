import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdminSessionService,
  adminTotpCode,
  adminTotpStep,
  createAdminTotpEnrollment,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import { createPostgresAdminSessions, PostgresAdminSessionStore } from './admin-session-store.js';
import {
  currentNativeAdminSession,
  inheritNativeAdminSessionPolicy,
} from './admin-session-policy.js';
import {
  createPostgresTotpAdminSessions,
  PostgresAdminTotpVerifier,
} from './admin-totp-verifier.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type TotpFixture = Readonly<{
  adminId: string;
  credentialId: string;
  actor: { kind: 'user'; userId: string };
  service: AdminSessionService;
  verifier: PostgresAdminTotpVerifier;
  query: Parameters<PostgresAdminTotpVerifier['verify']>[0];
  issue: (proof?: string) => ReturnType<AdminSessionService['issue']>;
  code: string;
  confirmationCode: string;
  initialStep: number;
  encoded: string;
}>;
describe.skipIf(url === undefined)('native authenticator proof and session admission', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  const key = randomBytes(32);
  const keys = { resolve: () => Buffer.from(key) };
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_admin_totp');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 20,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    key.fill(0);
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  async function fixture(wrongBinding = false): Promise<TotpFixture> {
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
    const credentialId = randomUUID();
    const enrollment = createAdminTotpEnrollment(
      { actorUserId: wrongBinding ? randomUUID() : admin.user_id, credentialId },
      { keyId: 'mfa-integration-key', keyVersion: 1, key },
    );
    const encoded = new URL(enrollment.enrollmentUri).searchParams.get('secret')!;
    const bits = [...encoded]
      .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
      .join('');
    const seed = Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
    const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!
      .at;
    const initialStep = adminTotpStep(at) - 1;
    const auditId = randomUUID();
    // Synthetic previously confirmed enrollment. Real approval/enrollment is a separate native increment.
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: auditId,
          category: 'security',
          event_type: 'administration.totp-activated.v1',
          actor_type: 'user',
          actor_user_id: admin.user_id,
          actor_admin_id: null,
          subject_type: 'admin_totp_credential',
          subject_id: credentialId,
          result_code: 'activated',
          metadata_schema_version: 1,
          metadata: {},
          request_id: randomUUID(),
          command_id: randomUUID(),
          occurred_at: at,
        })
        .execute();
      await sql`INSERT INTO administration.admin_totp_credentials(id,admin_user_id,ciphertext,nonce,key_id,key_version,activated_at,activation_audit_id,last_used_step)
        VALUES(${credentialId}::uuid,${adminId}::uuid,${Buffer.from(enrollment.secret.ciphertext)},${Buffer.from(enrollment.secret.nonce)},
          ${enrollment.secret.keyId},${enrollment.secret.keyVersion},${at}::timestamptz,${auditId}::uuid,${initialStep}::bigint)`.execute(
        tx,
      );
    });
    const code = adminTotpCode(seed, new Date((adminTotpStep(at) + 1) * 30000));
    const confirmationCode = adminTotpCode(seed, new Date(initialStep * 30000));
    seed.fill(0);
    const actor = { kind: 'user' as const, userId: admin.user_id };
    const service = createPostgresTotpAdminSessions(database, keys);
    const verifier = new PostgresAdminTotpVerifier(database, keys);
    const query = {
      actorUserId: actor.userId,
      telegramUserId: admin.telegram_user_id,
      proof: code,
      requestId: randomUUID(),
    };
    const issue = (proof = code): ReturnType<AdminSessionService['issue']> =>
      service.issue({
        actor,
        telegramUserId: admin.telegram_user_id,
        requestId: randomUUID(),
        proof,
      });
    return {
      adminId,
      credentialId,
      actor,
      service,
      verifier,
      query,
      issue,
      code,
      confirmationCode,
      initialStep,
      encoded,
    };
  }
  async function revoke(tx: NakhDatabase, f: TotpFixture): Promise<void> {
    const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx)).rows[0]!.at;
    const auditId = randomUUID();
    await tx
      .insertInto('platform.audit_logs')
      .values({
        id: auditId,
        category: 'security',
        event_type: 'administration.totp-revoked.v1',
        actor_type: 'user',
        actor_user_id: f.actor.userId,
        actor_admin_id: null,
        subject_type: 'admin_totp_credential',
        subject_id: f.credentialId,
        result_code: 'revoked',
        metadata_schema_version: 1,
        metadata: {},
        request_id: randomUUID(),
        command_id: randomUUID(),
        occurred_at: at,
      })
      .execute();
    await sql`UPDATE administration.admin_totp_credentials SET revoked_at=${at}::timestamptz,revocation_audit_id=${auditId}::uuid
      WHERE id=${f.credentialId}::uuid`.execute(tx);
  }
  it('admits one of twenty concurrent code submissions with one proof, session and verification audit', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => f.issue()));
    const successes = outcomes.filter((r) => r.status === 'fulfilled');
    expect(successes).toHaveLength(1);
    const result = successes[0]!.value;
    expect(
      await f.service.authenticate({ bearerToken: result.adminSessionToken, audience: 'admin' }),
    ).toEqual({ ...f.actor, kind: 'admin' });
    const proofs = (
      await sql`SELECT * FROM administration.admin_totp_proofs WHERE admin_user_id=${f.adminId}::uuid`.execute(
        database,
      )
    ).rows;
    const sessions = (
      await sql`SELECT * FROM administration.admin_sessions WHERE admin_user_id=${f.adminId}::uuid`.execute(
        database,
      )
    ).rows;
    const audits = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('actor_user_id', '=', f.actor.userId)
      .execute();
    expect(proofs).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(audits.filter((a) => a.event_type === 'administration.totp-verified.v1')).toHaveLength(
      1,
    );
    expect(audits.filter((a) => a.event_type === 'administration.totp-limited.v1')).toHaveLength(
      15,
    );
    const serialized = JSON.stringify({ proofs, sessions, audits });
    for (const secret of [f.encoded, result.adminSessionToken])
      expect(serialized).not.toContain(secret);
    expect(audits.every((audit) => JSON.stringify(audit.metadata) === '{}')).toBe(true);
    expect(
      (
        await sql<{
          attempts: number;
        }>`SELECT attempts FROM administration.admin_totp_attempt_windows WHERE admin_user_id=${f.adminId}::uuid`.execute(
          database,
        )
      ).rows[0]?.attempts,
    ).toBe(5);
    await expect(f.issue()).rejects.toMatchObject({ status: 401 });
  });
  it('keeps a stable proof for retries and rejects borrowed identity, proof and confirmation counters', async () => {
    const f = await fixture();
    await expect(f.issue(f.confirmationCode)).rejects.toMatchObject({ status: 401 });
    const first = await f.verifier.verify(f.query);
    expect(first).toBeDefined();
    const retry = await new PostgresAdminTotpVerifier(database, keys).verify({
      ...f.query,
      requestId: randomUUID(),
    });
    expect(retry).toEqual(first);
    await expect(
      sql`UPDATE administration.admin_totp_proofs SET expires_at=expires_at+interval '1 second'
      WHERE id=${first!.proofId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM administration.admin_totp_proofs WHERE id=${first!.proofId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await f.verifier.verify({ ...f.query, telegramUserId: '9999999999' })).toBeUndefined();
    const other = await fixture();
    const borrowed = new AdminSessionService(new PostgresAdminSessionStore(database, true), {
      verify: () =>
        Promise.resolve({
          ...first!,
          actorUserId: other.actor.userId,
          telegramUserId: other.query.telegramUserId,
        }),
    });
    await expect(
      borrowed.issue({
        actor: other.actor,
        telegramUserId: other.query.telegramUserId,
        requestId: randomUUID(),
        proof: other.code,
      }),
    ).rejects.toMatchObject({ status: 401 });
    const noNative = new AdminSessionService(new PostgresAdminSessionStore(database, true), {
      verify: () =>
        Promise.resolve({
          actorUserId: f.actor.userId,
          telegramUserId: f.query.telegramUserId,
          proofId: randomUUID(),
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() + 300000),
        }),
    });
    await expect(
      noNative.issue({
        actor: f.actor,
        telegramUserId: f.query.telegramUserId,
        requestId: randomUUID(),
        proof: f.code,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('enforces a durable five-minute attempt window across verifier restarts', async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => f.issue('wrong-code')),
    );
    expect(attempts.every((r) => r.status === 'rejected')).toBe(true);
    const restarted = new PostgresAdminTotpVerifier(database, keys);
    expect(await restarted.verify(f.query)).toBeUndefined();
    await sql`UPDATE administration.admin_totp_attempt_windows SET started_at=started_at-interval '5 minutes'
      WHERE admin_user_id=${f.adminId}::uuid`.execute(database);
    expect(await restarted.verify(f.query)).toBeDefined();
    expect(
      (
        await sql<{
          attempts: number;
        }>`SELECT attempts FROM administration.admin_totp_attempt_windows WHERE admin_user_id=${f.adminId}::uuid`.execute(
          database,
        )
      ).rows[0]?.attempts,
    ).toBe(1);
  });
  it('rejects legacy external grants and a later attempt to relax native TOTP composition', async () => {
    const f = await fixture();
    const legacyOwner = createDatabase({
      url: isolated!.url,
      poolMax: 2,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!
      .at;
    const external = {
      verify: () =>
        Promise.resolve({
          actorUserId: f.actor.userId,
          telegramUserId: f.query.telegramUserId,
          proofId: randomUUID(),
          verifiedAt: at,
          expiresAt: new Date(at.getTime() + 300000),
        }),
    };
    try {
      const historical = await createPostgresAdminSessions(legacyOwner, external).issue({
        actor: f.actor,
        telegramUserId: f.query.telegramUserId,
        requestId: randomUUID(),
        proof: 'synthetic-external-factor',
      });
      expect(
        await f.service.authenticate({
          bearerToken: historical.adminSessionToken,
          audience: 'admin',
        }),
      ).toBeUndefined();
      expect(await currentNativeAdminSession(database, f.adminId)).toBeUndefined();
      await database.transaction().execute(async (tx) => {
        inheritNativeAdminSessionPolicy(database, tx);
        expect(await currentNativeAdminSession(tx, f.adminId)).toBeUndefined();
      });
      await expect(
        createPostgresAdminSessions(database, external).issue({
          actor: f.actor,
          telegramUserId: f.query.telegramUserId,
          requestId: randomUUID(),
          proof: 'synthetic-external-factor',
        }),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      await legacyOwner.destroy();
    }
  });
  it('rechecks revoked credentials after waiting for the shared administrator lock', async () => {
    const f = await fixture();
    const proof = await f.verifier.verify(f.query);
    expect(proof).toBeDefined();
    const delayed = new AdminSessionService(new PostgresAdminSessionStore(database, true), {
      verify: () => Promise.resolve(proof),
    });
    let pending: Promise<unknown> | undefined;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT id FROM administration.admin_users WHERE id=${f.adminId}::uuid FOR UPDATE`.execute(
        tx,
      );
      // Attach the rejection handler immediately while the owner lock is held.
      pending = expect(
        delayed.issue({
          actor: f.actor,
          telegramUserId: f.query.telegramUserId,
          requestId: randomUUID(),
          proof: f.code,
        }),
      ).rejects.toMatchObject({ status: 401 });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (
          await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting`.execute(
            database,
          )
        ).rows[0]!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await revoke(tx, f);
    });
    await pending;
    expect(
      (
        await sql`SELECT id FROM administration.admin_sessions WHERE admin_user_id=${f.adminId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    await expect(f.issue()).rejects.toMatchObject({ status: 401 });
  });
  it('revocation invalidates existing sessions through both native authorization paths', async () => {
    const f = await fixture();
    const session = await f.issue();
    expect(await currentNativeAdminSession(database, f.adminId)).toBeDefined();
    await database.transaction().execute(async (tx) => {
      await sql`SELECT id FROM administration.admin_users WHERE id=${f.adminId}::uuid FOR UPDATE`.execute(
        tx,
      );
      await revoke(tx, f);
    });
    expect(
      await f.service.authenticate({ bearerToken: session.adminSessionToken, audience: 'admin' }),
    ).toBeUndefined();
    expect(await f.service.current(f.query.telegramUserId)).toBeUndefined();
    expect(await currentNativeAdminSession(database, f.adminId)).toBeUndefined();
    await expect(
      sql`UPDATE administration.admin_totp_credentials SET revoked_at=NULL,revocation_audit_id=NULL WHERE id=${f.credentialId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`DELETE FROM administration.admin_totp_credentials WHERE id=${f.credentialId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('rolls back counter consumption and proof on required audit failure, sanitizing the error', async () => {
    const f = await fixture();
    await sql`CREATE FUNCTION platform.reject_totp_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='administration.totp-verified.v1' THEN RAISE EXCEPTION 'private-test-audit-error'; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER totp_test_audit BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.reject_totp_test_audit()`.execute(
      database,
    );
    try {
      await expect(f.issue()).rejects.toMatchObject({ status: 500, message: 'error.m7.internal' });
      expect(
        (
          await sql<{
            step: string;
          }>`SELECT last_used_step AS step FROM administration.admin_totp_credentials WHERE id=${f.credentialId}::uuid`.execute(
            database,
          )
        ).rows[0]?.step,
      ).toBe(String(f.initialStep));
      expect(
        (
          await sql`SELECT id FROM administration.admin_totp_proofs WHERE admin_user_id=${f.adminId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql`SELECT admin_user_id FROM administration.admin_totp_attempt_windows WHERE admin_user_id=${f.adminId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER totp_test_audit ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION platform.reject_totp_test_audit()`.execute(database);
    }
    expect(await f.issue()).toHaveProperty('adminSessionToken');
  });
  it('fails closed for authenticated-shape ciphertext copied from another administrator', async () => {
    const f = await fixture(true);
    await expect(f.issue()).rejects.toMatchObject({ status: 500, message: 'error.m7.internal' });
    expect(
      (
        await sql`SELECT id FROM administration.admin_totp_proofs WHERE admin_user_id=${f.adminId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    await expect(
      sql`UPDATE administration.admin_totp_credentials SET nonce=${randomBytes(12)} WHERE id=${f.credentialId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
