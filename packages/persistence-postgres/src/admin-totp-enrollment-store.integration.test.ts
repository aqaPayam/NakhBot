import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminTotpCode, adminTotpStep } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresAdminTotpOperator, type AdminTotpApproval } from './admin-totp-operator-store.js';
import { PostgresAdminTotpEnrollments } from './admin-totp-enrollment-store.js';
import { createPostgresTotpAdminSessions } from './admin-totp-verifier.js';
import { adminTotpDatabaseTime } from './admin-totp-policy.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'approved native authenticator enrollment and operator recovery',
  () => {
    let database: NakhDatabase;
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
    const key = randomBytes(32),
      operatorId = randomUUID();
    const encryption = { keyId: 'mfa-enrollment-key', keyVersion: 1, key };
    const keys = {
      resolve: (id: string, version: number): Buffer | undefined =>
        id === encryption.keyId && version === 1 ? Buffer.from(key) : undefined,
    };
    let operator: PostgresAdminTotpOperator, enrollment: PostgresAdminTotpEnrollments;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'nakh_totp_enrollment');
      await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 20,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
      operator = new PostgresAdminTotpOperator(database, { operatorId }, encryption, keys);
      enrollment = new PostgresAdminTotpEnrollments(database, keys);
    });
    afterAll(async () => {
      operator?.dispose();
      key.fill(0);
      try {
        await database?.destroy();
      } finally {
        await isolated?.destroy();
      }
    });
    async function staff(): Promise<
      Readonly<{ actor: { kind: 'user'; userId: string }; telegramUserId: string }>
    > {
      const userId = await createReportUser(database),
        at = await adminTotpDatabaseTime(database);
      const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
      await database
        .insertInto('identity.telegram_identities')
        .values({
          user_id: userId,
          telegram_user_id: telegramUserId,
          username: null,
          first_seen_at: at,
          last_seen_at: at,
        })
        .execute();
      return { actor: { kind: 'user', userId }, telegramUserId };
    }
    function pending(
      approval: AdminTotpApproval,
    ): Extract<AdminTotpApproval, { status: 'pending' }> {
      if (approval.status !== 'pending') throw new Error('Synthetic pending approval unavailable.');
      return approval;
    }
    function codeAt(uri: string, at: Date): string {
      const encoded = new URL(uri).searchParams.get('secret')!;
      const bits = [...encoded]
        .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
        .join('');
      const seed = Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
      try {
        return adminTotpCode(seed, at);
      } finally {
        seed.fill(0);
      }
    }
    async function setup(): Promise<
      Readonly<{
        actor: { kind: 'user'; userId: string };
        telegramUserId: string;
        approval: Extract<AdminTotpApproval, { status: 'pending' }>;
        uri: string;
        requestId: string;
      }>
    > {
      const s = await staff();
      const requestId = randomUUID();
      const approval = pending(
        await operator.approve({
          actorUserId: s.actor.userId,
          requestId,
          roles: ['support'],
          reasonCode: 'bootstrap',
        }),
      );
      const opened = await enrollment.begin({
        actor: s.actor,
        invitationToken: approval.invitationToken,
        requestId: randomUUID(),
      });
      return { ...s, approval, uri: opened.enrollmentUri, requestId };
    }
    it('bootstraps one exact role and approval, releases one audited setup and activates once under twenty retries', async () => {
      const s = await staff(),
        requestId = randomUUID();
      const input = {
        actorUserId: s.actor.userId,
        requestId,
        roles: ['support' as const],
        reasonCode: 'bootstrap' as const,
      };
      const approvals = await Promise.all(
        Array.from({ length: 20 }, () => operator.approve(input)),
      );
      expect(
        approvals.every((result) => JSON.stringify(result) === JSON.stringify(approvals[0])),
      ).toBe(true);
      const approval = pending(approvals[0]!);
      const begin = {
        actor: s.actor,
        invitationToken: approval.invitationToken,
        requestId: randomUUID(),
      };
      const opened = await Promise.all(Array.from({ length: 20 }, () => enrollment.begin(begin)));
      expect(opened.every((result) => JSON.stringify(result) === JSON.stringify(opened[0]))).toBe(
        true,
      );
      const at = await adminTotpDatabaseTime(database),
        code = codeAt(opened[0]!.enrollmentUri, at);
      const confirmation = { ...begin, requestId: randomUUID(), code };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => enrollment.confirm(confirmation)),
      );
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(results.every((result) => result.status === 'activated')).toBe(true);
      const admin = await database
        .selectFrom('administration.admin_users')
        .selectAll()
        .where('user_id', '=', s.actor.userId)
        .executeTakeFirstOrThrow();
      const assigned = await database
        .selectFrom('administration.admin_user_roles')
        .select('role_code')
        .where('admin_user_id', '=', admin.id)
        .execute();
      expect(assigned).toEqual([{ role_code: 'support' }]);
      const commands = (
        await sql`SELECT * FROM administration.admin_totp_operator_commands WHERE admin_user_id=${admin.id}::uuid`.execute(
          database,
        )
      ).rows;
      const factors = (
        await sql<{
          id: string;
        }>`SELECT * FROM administration.admin_totp_credentials WHERE admin_user_id=${admin.id}::uuid`.execute(
          database,
        )
      ).rows;
      expect(commands).toHaveLength(1);
      expect(factors).toHaveLength(1);
      expect(
        (
          await sql`SELECT id FROM administration.admin_totp_proofs WHERE admin_user_id=${admin.id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql`SELECT id FROM administration.admin_sessions WHERE admin_user_id=${admin.id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      const audits = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('subject_id', '=', factors[0]!.id)
        .execute();
      expect(
        audits.filter((a) => a.event_type === 'administration.totp-enrollment-opened.v1'),
      ).toHaveLength(1);
      expect(
        audits.filter((a) => a.event_type === 'administration.totp-activated.v1'),
      ).toHaveLength(1);
      const stored = JSON.stringify({ commands, factors, audits });
      for (const secret of [
        approval.invitationToken,
        opened[0]!.enrollmentUri,
        new URL(opened[0]!.enrollmentUri).searchParams.get('secret')!,
      ])
        expect(stored).not.toContain(secret);
      const sessions = createPostgresTotpAdminSessions(database, keys);
      await expect(
        sessions.issue({
          actor: s.actor,
          telegramUserId: s.telegramUserId,
          requestId: randomUUID(),
          proof: code,
        }),
      ).rejects.toMatchObject({ status: 401 });
      const next = codeAt(opened[0]!.enrollmentUri, new Date((adminTotpStep(at) + 1) * 30000));
      expect(
        await sessions.issue({
          actor: s.actor,
          telegramUserId: s.telegramUserId,
          requestId: randomUUID(),
          proof: next,
        }),
      ).toHaveProperty('adminSessionToken');
      await expect(enrollment.begin({ ...begin, requestId: randomUUID() })).rejects.toMatchObject({
        status: 401,
      });
      expect(await operator.approve(input)).toEqual({ status: 'completed' });
    });
    it('binds approval replay to actor, exact role set, reason and authenticated operator context', async () => {
      const s = await setup(),
        other = await staff();
      const base = {
        actorUserId: s.actor.userId,
        requestId: s.requestId,
        roles: ['support' as const],
        reasonCode: 'bootstrap' as const,
      };
      for (const changed of [
        { ...base, actorUserId: other.actor.userId },
        { ...base, roles: ['moderator' as const] },
        { ...base, reasonCode: 'recovery' as const },
      ])
        await expect(operator.approve(changed)).rejects.toMatchObject({ status: 409 });
      const otherOperator = new PostgresAdminTotpOperator(
        database,
        { operatorId: randomUUID() },
        encryption,
        keys,
      );
      try {
        await expect(otherOperator.approve(base)).rejects.toMatchObject({ status: 409 });
      } finally {
        otherOperator.dispose();
      }
      await expect(
        operator.approve({ ...base, requestId: randomUUID(), roles: ['moderator'] }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await operator.approve(base)).toEqual(s.approval);
      await expect(
        enrollment.begin({
          actor: other.actor,
          invitationToken: s.approval.invitationToken,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        enrollment.begin({
          actor: { ...s.actor, kind: 'admin' },
          invitationToken: s.approval.invitationToken,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 401 });
      const pendingRow = (
        await sql<{
          id: string;
        }>`SELECT id FROM administration.admin_totp_enrollments WHERE operator_request_id=${s.requestId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      await expect(
        sql`UPDATE administration.admin_totp_enrollments SET key_version=key_version+1 WHERE id=${pendingRow.id}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        sql`DELETE FROM administration.admin_totp_operator_commands WHERE request_id=${s.requestId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });
    it('invalidates replaced invitations and reconstructs original grants across retained-key rotation', async () => {
      const s = await setup();
      const nextKey = randomBytes(32);
      const nextEncryption = { keyId: 'mfa-enrollment-key-next', keyVersion: 2, key: nextKey };
      const rotatedKeys = {
        resolve: (id: string, version: number): Buffer | undefined =>
          id === nextEncryption.keyId && version === 2
            ? Buffer.from(nextKey)
            : keys.resolve(id, version),
      };
      const rotated = new PostgresAdminTotpOperator(
        database,
        { operatorId },
        nextEncryption,
        rotatedKeys,
      );
      try {
        const replay = await rotated.approve({
          actorUserId: s.actor.userId,
          requestId: s.requestId,
          roles: ['support'],
          reasonCode: 'bootstrap',
        });
        expect(replay).toEqual(s.approval);
        const second = pending(
          await rotated.approve({
            actorUserId: s.actor.userId,
            requestId: randomUUID(),
            roles: ['support'],
            reasonCode: 'enrollment',
          }),
        );
        expect(second.invitationToken).not.toBe(s.approval.invitationToken);
        await expect(
          enrollment.begin({
            actor: s.actor,
            invitationToken: s.approval.invitationToken,
            requestId: randomUUID(),
          }),
        ).rejects.toMatchObject({ status: 401 });
        const newEnrollment = new PostgresAdminTotpEnrollments(database, rotatedKeys);
        const opened = await newEnrollment.begin({
          actor: s.actor,
          invitationToken: second.invitationToken,
          requestId: randomUUID(),
        });
        const code = codeAt(opened.enrollmentUri, await adminTotpDatabaseTime(database));
        expect(
          await newEnrollment.confirm({
            actor: s.actor,
            invitationToken: second.invitationToken,
            requestId: randomUUID(),
            code,
          }),
        ).toMatchObject({ status: 'activated', replayed: false });
      } finally {
        rotated.dispose();
        nextKey.fill(0);
      }
    });
    it('persists failed confirmations and rate limits across instances without activating a factor', async () => {
      const s = await setup();
      const at = await adminTotpDatabaseTime(database),
        step = adminTotpStep(at);
      const valid = codeAt(s.uri, at);
      const nearby = new Set(
        Array.from({ length: 7 }, (_, index) =>
          codeAt(s.uri, new Date((step + index - 3) * 30000)),
        ),
      );
      let candidate = 0;
      while (nearby.has(String(candidate).padStart(6, '0'))) candidate++;
      const bad = String(candidate).padStart(6, '0');
      const failures = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          enrollment.confirm({
            actor: s.actor,
            invitationToken: s.approval.invitationToken,
            requestId: randomUUID(),
            code: bad,
          }),
        ),
      );
      expect(failures.every((r) => r.status === 'rejected')).toBe(true);
      await expect(
        new PostgresAdminTotpEnrollments(database, keys).confirm({
          actor: s.actor,
          invitationToken: s.approval.invitationToken,
          requestId: randomUUID(),
          code: valid,
        }),
      ).rejects.toMatchObject({ status: 401 });
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', s.actor.userId)
        .executeTakeFirstOrThrow();
      expect(
        (
          await sql`SELECT id FROM administration.admin_totp_credentials WHERE admin_user_id=${admin.id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql<{
            attempts: number;
          }>`SELECT attempts FROM administration.admin_totp_attempt_windows WHERE admin_user_id=${admin.id}::uuid`.execute(
            database,
          )
        ).rows[0]?.attempts,
      ).toBe(5);
    });
    it('keeps recovery separate, revokes sessions once, and cannot replay an old revocation against a replacement', async () => {
      const s = await setup(),
        confirmationId = randomUUID(),
        at = await adminTotpDatabaseTime(database);
      const code = codeAt(s.uri, at);
      await enrollment.confirm({
        actor: s.actor,
        invitationToken: s.approval.invitationToken,
        requestId: confirmationId,
        code,
      });
      const credential = (
        await sql<{
          id: string;
        }>`SELECT credential.id FROM administration.admin_totp_credentials credential
      JOIN administration.admin_users admin ON admin.id=credential.admin_user_id WHERE admin.user_id=${s.actor.userId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      const sessions = createPostgresTotpAdminSessions(database, keys);
      const token = await sessions.issue({
        actor: s.actor,
        telegramUserId: s.telegramUserId,
        requestId: randomUUID(),
        proof: codeAt(s.uri, new Date((adminTotpStep(at) + 1) * 30000)),
      });
      await expect(
        operator.approve({
          actorUserId: s.actor.userId,
          requestId: randomUUID(),
          roles: ['support'],
          reasonCode: 'recovery',
        }),
      ).rejects.toMatchObject({ status: 409 });
      const revoke = {
        actorUserId: s.actor.userId,
        credentialId: credential.id,
        requestId: randomUUID(),
        reasonCode: 'recovery' as const,
      };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => operator.revokeCredential(revoke)),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        await sessions.authenticate({ bearerToken: token.adminSessionToken, audience: 'admin' }),
      ).toBeUndefined();
      await expect(
        enrollment.confirm({
          actor: s.actor,
          invitationToken: s.approval.invitationToken,
          requestId: confirmationId,
          code,
        }),
      ).rejects.toMatchObject({ status: 401 });
      const replacement = pending(
        await operator.approve({
          actorUserId: s.actor.userId,
          requestId: randomUUID(),
          roles: ['support'],
          reasonCode: 'recovery',
        }),
      );
      const opened = await enrollment.begin({
        actor: s.actor,
        invitationToken: replacement.invitationToken,
        requestId: randomUUID(),
      });
      await enrollment.confirm({
        actor: s.actor,
        invitationToken: replacement.invitationToken,
        requestId: randomUUID(),
        code: codeAt(opened.enrollmentUri, await adminTotpDatabaseTime(database)),
      });
      expect(await operator.revokeCredential(revoke)).toEqual({
        status: 'revoked',
        replayed: true,
      });
      const active = (
        await sql<{
          id: string;
        }>`SELECT credential.id FROM administration.admin_totp_credentials credential
      JOIN administration.admin_users admin ON admin.id=credential.admin_user_id WHERE admin.user_id=${s.actor.userId}::uuid AND credential.revoked_at IS NULL`.execute(
          database,
        )
      ).rows;
      expect(active).toHaveLength(1);
      expect(active[0]!.id).not.toBe(credential.id);
      await expect(
        operator.revokeCredential({ ...revoke, credentialId: active[0]!.id }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('denies expired approval and revoked roles before releasing or activating enrollment material', async () => {
      const expired = await setup();
      // Isolated historical fixture only; ordinary enrollment timestamps/material remain immutable.
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        await sql`UPDATE administration.admin_totp_enrollments SET approved_at=approved_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes'
        WHERE operator_request_id=${expired.requestId}::uuid`.execute(tx);
      });
      await expect(
        enrollment.begin({
          actor: expired.actor,
          invitationToken: expired.approval.invitationToken,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 401 });
      const s = await setup();
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', s.actor.userId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable('administration.admin_user_roles')
        .set({ revoked_at: await adminTotpDatabaseTime(database), revoked_by_admin_id: admin.id })
        .where('admin_user_id', '=', admin.id)
        .execute();
      await expect(
        enrollment.confirm({
          actor: s.actor,
          invitationToken: s.approval.invitationToken,
          requestId: randomUUID(),
          code: codeAt(s.uri, await adminTotpDatabaseTime(database)),
        }),
      ).rejects.toMatchObject({ status: 401 });
    });
    it('rolls back provisioning and activation when their required security audits fail', async () => {
      const s = await staff();
      await sql`CREATE FUNCTION platform.reject_enrollment_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type IN ('administration.totp-enrollment-approved.v1','administration.totp-activated.v1')
        THEN RAISE EXCEPTION 'private-enrollment-audit-error'; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER enrollment_test_audit BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.reject_enrollment_test_audit()`.execute(
        database,
      );
      try {
        await expect(
          operator.approve({
            actorUserId: s.actor.userId,
            requestId: randomUUID(),
            roles: ['support'],
            reasonCode: 'bootstrap',
          }),
        ).rejects.toMatchObject({ status: 500, message: 'error.m7.internal' });
        expect(
          await database
            .selectFrom('administration.admin_users')
            .select('id')
            .where('user_id', '=', s.actor.userId)
            .execute(),
        ).toEqual([]);
      } finally {
        await sql`DROP TRIGGER enrollment_test_audit ON platform.audit_logs`.execute(database);
      }
      const ready = await setup();
      await sql`CREATE TRIGGER enrollment_test_audit BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.reject_enrollment_test_audit()`.execute(
        database,
      );
      try {
        await expect(
          enrollment.confirm({
            actor: ready.actor,
            invitationToken: ready.approval.invitationToken,
            requestId: randomUUID(),
            code: codeAt(ready.uri, await adminTotpDatabaseTime(database)),
          }),
        ).rejects.toMatchObject({ status: 500, message: 'error.m7.internal' });
        const row = (
          await sql<{
            completed_at: Date | null;
          }>`SELECT completed_at FROM administration.admin_totp_enrollments WHERE operator_request_id=${ready.requestId}::uuid`.execute(
            database,
          )
        ).rows[0]!;
        expect(row.completed_at).toBeNull();
      } finally {
        await sql`DROP TRIGGER enrollment_test_audit ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION platform.reject_enrollment_test_audit()`.execute(database);
      }
      expect(
        await enrollment.confirm({
          actor: ready.actor,
          invitationToken: ready.approval.invitationToken,
          requestId: randomUUID(),
          code: codeAt(ready.uri, await adminTotpDatabaseTime(database)),
        }),
      ).toMatchObject({ status: 'activated' });
    });
  },
);
