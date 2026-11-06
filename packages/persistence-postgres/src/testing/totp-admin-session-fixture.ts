import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { adminTotpCode, adminTotpStep, createAdminTotpEnrollment } from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import type { NativeAdminSessionPrincipal } from '../admin-session-policy.js';
import { createPostgresTotpAdminSessions } from '../admin-totp-verifier.js';
import { createReportFixtureAdmin } from './report-fixture.js';

/** Synthetic native encrypted enrollment plus a real one-time-code verification
 * and session transaction. This does not qualify real operator enrollment. */
export async function createTotpAdminSessionFixture(database: NakhDatabase): Promise<
  Readonly<{
    principal: NativeAdminSessionPrincipal;
    telegramUserId: string;
    revoke: () => Promise<void>;
    issueNext: () => Promise<NativeAdminSessionPrincipal>;
    revokeCredential: () => Promise<void>;
    dispose: () => void;
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
  const key = randomBytes(32),
    credentialId = randomUUID();
  const enrollment = createAdminTotpEnrollment(
    { actorUserId: admin.user_id, credentialId },
    { keyId: 'synthetic-profile-review', keyVersion: 1, key },
  );
  const encoded = new URL(enrollment.enrollmentUri).searchParams.get('secret')!;
  const bits = [...encoded]
    .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const seed = Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
  const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!
    .at;
  const step = adminTotpStep(at),
    auditId = randomUUID();
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
        command_id: randomUUID(),
        request_id: randomUUID(),
        occurred_at: at,
      })
      .execute();
    await sql`INSERT INTO administration.admin_totp_credentials(id,admin_user_id,ciphertext,nonce,key_id,key_version,activated_at,activation_audit_id,last_used_step)
      VALUES(${credentialId}::uuid,${adminId}::uuid,${Buffer.from(enrollment.secret.ciphertext)},${Buffer.from(enrollment.secret.nonce)},
      ${enrollment.secret.keyId},${enrollment.secret.keyVersion},${at}::timestamptz,${auditId}::uuid,${step - 1}::bigint)`.execute(
      tx,
    );
  });
  const service = createPostgresTotpAdminSessions(database, { resolve: () => Buffer.from(key) });
  const issue = async (
    counter: number,
  ): Promise<{ principal: NativeAdminSessionPrincipal; token: string }> => {
    const result = await service.issue({
      actor: { kind: 'user', userId: admin.user_id },
      telegramUserId: admin.telegram_user_id,
      requestId: randomUUID(),
      proof: adminTotpCode(seed, new Date(counter * 30000)),
    });
    const row = (
      await sql<{
        id: string;
      }>`SELECT id FROM administration.admin_sessions WHERE token_hash=${createHash('sha256').update(result.adminSessionToken).digest('hex')}`.execute(
        database,
      )
    ).rows[0]!;
    return {
      principal: { adminUserId: adminId, actorUserId: admin.user_id, sessionId: row.id },
      token: result.adminSessionToken,
    };
  };
  const first = await issue(step);
  return {
    principal: first.principal,
    telegramUserId: admin.telegram_user_id,
    revoke: () =>
      service.revoke({
        actor: { kind: 'admin', userId: admin.user_id },
        adminSessionToken: first.token,
        requestId: randomUUID(),
      }),
    issueNext: async () => (await issue(Math.max(step + 1, adminTotpStep(new Date())))).principal,
    revokeCredential: () =>
      database.transaction().execute(async (tx) => {
        const now = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx)).rows[0]!
            .at,
          id = randomUUID();
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id,
            category: 'security',
            event_type: 'administration.totp-revoked.v1',
            actor_type: 'user',
            actor_user_id: admin.user_id,
            actor_admin_id: null,
            subject_type: 'admin_totp_credential',
            subject_id: credentialId,
            result_code: 'revoked',
            metadata_schema_version: 1,
            metadata: {},
            request_id: randomUUID(),
            command_id: randomUUID(),
            occurred_at: now,
          })
          .execute();
        await sql`UPDATE administration.admin_totp_credentials SET revoked_at=${now}::timestamptz,revocation_audit_id=${id}::uuid WHERE id=${credentialId}::uuid`.execute(
          tx,
        );
      }),
    dispose: () => {
      seed.fill(0);
      key.fill(0);
    },
  };
}
