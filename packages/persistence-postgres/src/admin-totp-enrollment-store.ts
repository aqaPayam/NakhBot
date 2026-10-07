import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  recoverAdminTotpEnrollmentUri,
  verifyProtectedAdminTotp,
  type AdminTotpEnrollments,
  type AdminTotpKeyResolver,
  type ProtectedAdminTotpSecret,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { requireNativeAdminTotp } from './admin-session-policy.js';
import {
  adminTotpDatabaseTime,
  consumeAdminTotpAttempt,
  hasAdminTotpIdentityAndRoles,
} from './admin-totp-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Enrollment = {
  id: string;
  admin_user_id: string;
  admin_version: number;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  key_version: number;
  expires_at: Date;
  completed_at: Date | null;
  completion_audit_id: string | null;
  cancelled_at: Date | null;
};
function unavailable(): ApplicationError {
  return new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
}
function material(enrollment: Enrollment): ProtectedAdminTotpSecret {
  return {
    ciphertext: enrollment.ciphertext,
    nonce: enrollment.nonce,
    keyId: enrollment.key_id,
    keyVersion: enrollment.key_version,
  };
}
/** Operator approval and the authenticated user's code are separate authorities. No setup method issues a session. */
export class PostgresAdminTotpEnrollments implements AdminTotpEnrollments {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly keys: AdminTotpKeyResolver,
  ) {
    requireNativeAdminTotp(database);
  }
  private validate(input: Parameters<AdminTotpEnrollments['begin']>[0]): void {
    if (
      input.actor.kind !== 'user' ||
      !UUID.test(input.actor.userId) ||
      !UUID.test(input.requestId) ||
      !/^v1\.mt\.[A-Za-z0-9_-]{43}$/u.test(input.invitationToken)
    )
      throw unavailable();
  }
  private async load(
    tx: NakhDatabase,
    input: Parameters<AdminTotpEnrollments['begin']>[0],
  ): Promise<Enrollment> {
    const admin = (
      await sql<{ id: string; version: number }>`SELECT id,version FROM administration.admin_users
      WHERE user_id=${input.actor.userId}::uuid FOR UPDATE`.execute(tx)
    ).rows[0];
    if (admin === undefined || !(await hasAdminTotpIdentityAndRoles(tx, admin.id)))
      throw unavailable();
    const invitationHash = createHash('sha256').update(input.invitationToken).digest('hex');
    const enrollment = (
      await sql<Enrollment>`SELECT * FROM administration.admin_totp_enrollments
      WHERE admin_user_id=${admin.id}::uuid AND invitation_hash=${invitationHash}
      AND admin_version=${admin.version} FOR UPDATE`.execute(tx)
    ).rows[0];
    if (enrollment === undefined || enrollment.cancelled_at !== null) throw unavailable();
    return enrollment;
  }
  private async audit(
    tx: NakhDatabase,
    input: Parameters<AdminTotpEnrollments['begin']>[0],
    enrollment: Enrollment,
    result: 'opened' | 'rejected' | 'limited' | 'activated',
    at: Date,
    id = randomUUID(),
  ): Promise<void> {
    await tx
      .insertInto('platform.audit_logs')
      .values({
        id,
        category: 'security',
        event_type:
          result === 'activated'
            ? 'administration.totp-activated.v1'
            : `administration.totp-enrollment-${result}.v1`,
        actor_type: 'user',
        actor_user_id: input.actor.userId,
        actor_admin_id: null,
        subject_type: result === 'activated' ? 'admin_totp_credential' : 'admin_totp_enrollment',
        subject_id: enrollment.id,
        result_code: result,
        metadata_schema_version: 1,
        metadata: {},
        request_id: input.requestId,
        command_id: randomUUID(),
        occurred_at: at,
      })
      .execute();
  }
  private async safe<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof ApplicationError && error.status === 401) throw unavailable();
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  public async begin(
    input: Parameters<AdminTotpEnrollments['begin']>[0],
  ): ReturnType<AdminTotpEnrollments['begin']> {
    this.validate(input);
    return this.safe(() =>
      this.database.transaction().execute(async (tx) => {
        const enrollment = await this.load(tx, input),
          at = await adminTotpDatabaseTime(tx);
        if (enrollment.completed_at !== null || enrollment.expires_at.getTime() <= at.getTime())
          throw unavailable();
        const active = (
          await sql`SELECT id FROM administration.admin_totp_credentials
        WHERE admin_user_id=${enrollment.admin_user_id}::uuid AND revoked_at IS NULL`.execute(tx)
        ).rows[0];
        if (active !== undefined) throw unavailable();
        const uri = recoverAdminTotpEnrollmentUri(
          { actorUserId: input.actor.userId, credentialId: enrollment.id },
          material(enrollment),
          this.keys,
        );
        const recorded = (
          await sql`SELECT id FROM platform.audit_logs WHERE category='security'
        AND event_type='administration.totp-enrollment-opened.v1' AND subject_id=${enrollment.id}::uuid
        AND actor_type='user' AND actor_user_id=${input.actor.userId}::uuid AND request_id=${input.requestId}::uuid`.execute(
            tx,
          )
        ).rows[0];
        if (recorded === undefined) await this.audit(tx, input, enrollment, 'opened', at);
        if (
          (await adminTotpDatabaseTime(tx)).getTime() >= enrollment.expires_at.getTime() ||
          !(await hasAdminTotpIdentityAndRoles(tx, enrollment.admin_user_id))
        )
          throw unavailable();
        return { enrollmentUri: uri, expiresAt: enrollment.expires_at.toISOString() };
      }),
    );
  }
  public async confirm(
    input: Parameters<AdminTotpEnrollments['confirm']>[0],
  ): ReturnType<AdminTotpEnrollments['confirm']> {
    this.validate(input);
    if (!/^[0-9]{6}$/u.test(input.code)) throw unavailable();
    const result = await this.safe(() =>
      this.database.transaction().execute(async (tx) => {
        const enrollment = await this.load(tx, input),
          at = await adminTotpDatabaseTime(tx);
        if (enrollment.completed_at !== null) {
          const completed = (
            await sql`SELECT credential.id FROM administration.admin_totp_credentials credential
          JOIN platform.audit_logs audit ON audit.id=credential.activation_audit_id
          WHERE credential.id=${enrollment.id}::uuid AND credential.admin_user_id=${enrollment.admin_user_id}::uuid
          AND credential.revoked_at IS NULL AND audit.request_id=${input.requestId}::uuid
          AND audit.id=${enrollment.completion_audit_id}::uuid`.execute(tx)
          ).rows[0];
          if (completed === undefined) throw unavailable();
          // This is a receipt of the original activation, never another factor proof or grant.
          return { status: 'activated' as const, replayed: true };
        }
        if (enrollment.expires_at.getTime() <= at.getTime()) throw unavailable();
        const active = (
          await sql`SELECT id FROM administration.admin_totp_credentials
        WHERE admin_user_id=${enrollment.admin_user_id}::uuid AND revoked_at IS NULL`.execute(tx)
        ).rows[0];
        if (active !== undefined) throw unavailable();
        if (!(await consumeAdminTotpAttempt(tx, enrollment.admin_user_id, at))) {
          await this.audit(tx, input, enrollment, 'limited', at);
          return undefined;
        }
        const step = verifyProtectedAdminTotp(
          { actorUserId: input.actor.userId, credentialId: enrollment.id },
          material(enrollment),
          this.keys,
          input.code,
          at,
        );
        if (step === undefined) {
          await this.audit(tx, input, enrollment, 'rejected', at);
          return undefined;
        }
        const auditId = randomUUID();
        await this.audit(tx, input, enrollment, 'activated', at, auditId);
        await sql`INSERT INTO administration.admin_totp_credentials(id,admin_user_id,ciphertext,nonce,key_id,key_version,activated_at,activation_audit_id,last_used_step)
        VALUES(${enrollment.id}::uuid,${enrollment.admin_user_id}::uuid,${enrollment.ciphertext},${enrollment.nonce},${enrollment.key_id},${enrollment.key_version},
          ${at}::timestamptz,${auditId}::uuid,${step}::bigint)`.execute(tx);
        await sql`UPDATE administration.admin_totp_enrollments SET completed_at=${at}::timestamptz,completion_audit_id=${auditId}::uuid
        WHERE id=${enrollment.id}::uuid`.execute(tx);
        if (
          (await adminTotpDatabaseTime(tx)).getTime() >= enrollment.expires_at.getTime() ||
          !(await hasAdminTotpIdentityAndRoles(tx, enrollment.admin_user_id))
        )
          throw unavailable();
        return { status: 'activated' as const, replayed: false };
      }),
    );
    if (result === undefined) throw unavailable();
    return result;
  }
}
