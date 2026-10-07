import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import {
  createAdminTotpEnrollment,
  createAdminTotpInvitation,
  type AdminTotpEncryptionKey,
  type AdminTotpKeyResolver,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { adminTotpDatabaseTime, hasAdminTotpIdentityAndRoles } from './admin-totp-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLES = ['super_admin', 'moderator', 'support'] as const;
const REASONS = ['bootstrap', 'enrollment', 'recovery'] as const;
export type AdminTotpProvisionRole = (typeof ROLES)[number];
export type AdminTotpOperatorReason = (typeof REASONS)[number];
function validRoles(value: unknown): value is readonly AdminTotpProvisionRole[] {
  const roles = Array.isArray(value) ? (value as readonly unknown[]) : undefined;
  return (
    roles !== undefined &&
    roles.length > 0 &&
    roles.length <= 3 &&
    new Set(roles).size === roles.length &&
    roles.every((role) => typeof role === 'string' && ROLES.some((known) => known === role))
  );
}
export type AdminTotpApproval =
  | Readonly<{
      status: 'pending';
      invitationToken: string;
      expiresAt: string;
    }>
  | Readonly<{ status: 'completed' | 'unavailable' }>;
type Receipt = {
  request_digest: string;
  operator_id: string;
  operation: string;
  admin_user_id: string;
  subject_id: string;
};
type Pending = {
  id: string;
  admin_user_id: string;
  admin_version: number;
  operator_request_id: string;
  key_id: string;
  key_version: number;
  expires_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
};
function unavailable(): ApplicationError {
  return new ApplicationError('forbidden', 'error.m7.unavailable', 403);
}
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.m7.unavailable', 409);
}
/** Restricted operational capability, instantiated only by an authenticated operator host.
 * operatorId comes from that trusted host configuration, never an HTTP/Telegram request.
 * This capability is deliberately absent from end-user/admin route composition. */
export class PostgresAdminTotpOperator {
  private readonly encryption: AdminTotpEncryptionKey;
  private readonly operatorId: string;
  private disposed = false;
  public constructor(
    private readonly database: NakhDatabase,
    operator: Readonly<{ operatorId: string }>,
    encryption: AdminTotpEncryptionKey,
    private readonly keys: AdminTotpKeyResolver,
  ) {
    if (
      !UUID.test(operator.operatorId) ||
      !/^[A-Za-z0-9_-]{8,160}$/u.test(encryption.keyId) ||
      !Number.isSafeInteger(encryption.keyVersion) ||
      encryption.keyVersion < 1 ||
      encryption.key.byteLength !== 32
    )
      throw new Error('Invalid MFA operator configuration.');
    this.operatorId = operator.operatorId.toLowerCase();
    this.encryption = { ...encryption, key: Buffer.from(encryption.key) };
    let resolved: Uint8Array | undefined;
    try {
      resolved = this.keys.resolve(encryption.keyId, encryption.keyVersion);
      if (
        resolved === undefined ||
        resolved.byteLength !== 32 ||
        !timingSafeEqual(this.encryption.key, resolved)
      )
        throw new Error('Invalid MFA operator configuration.');
    } catch {
      this.encryption.key.fill(0);
      throw new Error('Invalid MFA operator configuration.');
    } finally {
      resolved?.fill(0);
    }
  }
  public dispose(): void {
    this.disposed = true;
    this.encryption.key.fill(0);
  }
  private validate(
    input: Readonly<{
      actorUserId: string;
      requestId: string;
      reasonCode: AdminTotpOperatorReason;
    }>,
  ): void {
    if (
      this.disposed ||
      !UUID.test(input.actorUserId) ||
      !UUID.test(input.requestId) ||
      !REASONS.includes(input.reasonCode)
    )
      throw unavailable();
  }
  private async safe<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof ApplicationError && [403, 409].includes(error.status))
        throw error.status === 403 ? unavailable() : conflict();
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  private async prior(
    tx: NakhDatabase,
    requestId: string,
    digest: string,
    operation: 'approve' | 'revoke',
  ): Promise<Receipt | undefined> {
    // One request cannot race across users, operations or authenticated operator identities.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId.toLowerCase()},0))`.execute(
      tx,
    );
    const receipt = (
      await sql<Receipt>`SELECT * FROM administration.admin_totp_operator_commands
      WHERE request_id=${requestId}::uuid`.execute(tx)
    ).rows[0];
    if (
      receipt !== undefined &&
      (receipt.request_digest !== digest ||
        receipt.operator_id !== this.operatorId ||
        receipt.operation !== operation)
    )
      throw conflict();
    return receipt;
  }
  private async audit(
    tx: NakhDatabase,
    input: Readonly<{ requestId: string; reasonCode: AdminTotpOperatorReason }>,
    digest: string,
    subjectId: string,
    result: 'approved' | 'cancelled' | 'revoked' | 'session_revoked',
    at: Date,
    roles?: readonly AdminTotpProvisionRole[],
  ): Promise<string> {
    const id = randomUUID();
    const event = {
      approved: 'administration.totp-enrollment-approved.v1',
      cancelled: 'administration.totp-enrollment-cancelled.v1',
      revoked: 'administration.totp-revoked.v1',
      session_revoked: 'administration.session-revoked-by-operator.v1',
    }[result];
    await tx
      .insertInto('platform.audit_logs')
      .values({
        id,
        category: 'security',
        event_type: event,
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        subject_type:
          result === 'revoked'
            ? 'admin_totp_credential'
            : result === 'session_revoked'
              ? 'admin_session'
              : 'admin_totp_enrollment',
        subject_id: subjectId,
        result_code: result === 'session_revoked' ? 'revoked' : result,
        metadata_schema_version: 1,
        metadata: {
          operatorId: this.operatorId,
          requestDigest: digest,
          reasonCode: input.reasonCode,
          ...(roles === undefined ? {} : { roles }),
        },
        request_id: input.requestId,
        command_id: input.requestId,
        occurred_at: at,
      })
      .execute();
    return id;
  }
  private async record(
    tx: NakhDatabase,
    input: Readonly<{ requestId: string }>,
    digest: string,
    operation: 'approve' | 'revoke',
    adminId: string,
    subjectId: string,
    auditId: string,
    at: Date,
  ): Promise<void> {
    await sql`INSERT INTO administration.admin_totp_operator_commands(request_id,request_digest,operator_id,operation,admin_user_id,subject_id,audit_id,created_at)
      VALUES(${input.requestId}::uuid,${digest},${this.operatorId}::uuid,${operation},${adminId}::uuid,${subjectId}::uuid,${auditId}::uuid,${at}::timestamptz)`.execute(
      tx,
    );
  }
  private async approval(
    tx: NakhDatabase,
    pending: Pending,
    actorUserId: string,
  ): Promise<AdminTotpApproval> {
    const admin = (
      await sql<{ version: number }>`SELECT version FROM administration.admin_users
      WHERE id=${pending.admin_user_id}::uuid AND user_id=${actorUserId}::uuid FOR UPDATE`.execute(
        tx,
      )
    ).rows[0];
    if (
      admin === undefined ||
      admin.version !== pending.admin_version ||
      !(await hasAdminTotpIdentityAndRoles(tx, pending.admin_user_id))
    )
      return { status: 'unavailable' };
    if (pending.completed_at !== null) return { status: 'completed' };
    if (
      pending.cancelled_at !== null ||
      pending.expires_at.getTime() <= (await adminTotpDatabaseTime(tx)).getTime()
    )
      return { status: 'unavailable' };
    const key = this.keys.resolve(pending.key_id, pending.key_version);
    if (key === undefined) throw new Error('MFA invitation is unavailable.');
    try {
      const invitationToken = createAdminTotpInvitation(
        { actorUserId, credentialId: pending.id },
        pending.operator_request_id,
        { keyId: pending.key_id, keyVersion: pending.key_version, key },
      );
      return { status: 'pending', invitationToken, expiresAt: pending.expires_at.toISOString() };
    } finally {
      key.fill(0);
    }
  }
  public async approve(
    input: Readonly<{
      actorUserId: string;
      requestId: string;
      roles: readonly AdminTotpProvisionRole[];
      reasonCode: AdminTotpOperatorReason;
    }>,
  ): Promise<AdminTotpApproval> {
    this.validate(input);
    if (!validRoles(input.roles)) throw unavailable();
    const roles = [...input.roles].sort();
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          'approve',
          this.operatorId,
          input.actorUserId.toLowerCase(),
          roles,
          input.reasonCode,
        ]),
      )
      .digest('hex');
    return this.safe(() =>
      this.database.transaction().execute(async (tx) => {
        const previous = await this.prior(tx, input.requestId, digest, 'approve');
        if (previous !== undefined) {
          const pending = (
            await sql<Pending>`SELECT * FROM administration.admin_totp_enrollments WHERE id=${previous.subject_id}::uuid`.execute(
              tx,
            )
          ).rows[0];
          if (pending === undefined) throw unavailable();
          return this.approval(tx, pending, input.actorUserId);
        }
        const identity = (
          await sql<{
            telegram_user_id: string;
          }>`SELECT telegram_user_id::text FROM identity.telegram_identities
        WHERE user_id=${input.actorUserId}::uuid FOR UPDATE`.execute(tx)
        ).rows[0];
        if (identity === undefined) throw unavailable();
        let admin = (
          await sql<{
            id: string;
            version: number;
            is_active: boolean;
            telegram_user_id: string;
          }>`SELECT id,version,is_active,telegram_user_id::text
        FROM administration.admin_users WHERE user_id=${input.actorUserId}::uuid FOR UPDATE`.execute(
            tx,
          )
        ).rows[0];
        const at = await adminTotpDatabaseTime(tx);
        if (admin === undefined) {
          admin = {
            id: randomUUID(),
            version: 1,
            is_active: true,
            telegram_user_id: identity.telegram_user_id,
          };
          await tx
            .insertInto('administration.admin_users')
            .values({
              id: admin.id,
              user_id: input.actorUserId,
              telegram_user_id: identity.telegram_user_id,
              is_active: true,
              disabled_at: null,
              identity_verified_at: at,
              created_at: at,
              updated_at: at,
            })
            .execute();
        }
        if (!admin.is_active || admin.telegram_user_id !== identity.telegram_user_id)
          throw unavailable();
        const active = (
          await sql`SELECT id FROM administration.admin_totp_credentials
        WHERE admin_user_id=${admin.id}::uuid AND revoked_at IS NULL`.execute(tx)
        ).rows[0];
        if (active !== undefined) throw conflict();
        const assigned = await tx
          .selectFrom('administration.admin_user_roles')
          .select('role_code')
          .where('admin_user_id', '=', admin.id)
          .where('revoked_at', 'is', null)
          .orderBy('role_code')
          .execute();
        if (
          assigned.length !== 0 &&
          JSON.stringify(assigned.map((row) => row.role_code)) !== JSON.stringify(roles)
        )
          throw conflict();
        for (const roleCode of roles) {
          const role = await tx
            .selectFrom('administration.admin_roles')
            .select('code')
            .where('code', '=', roleCode)
            .where('is_active', '=', true)
            .executeTakeFirst();
          if (role === undefined) throw unavailable();
          const assignment = await tx
            .selectFrom('administration.admin_user_roles')
            .select('revoked_at')
            .where('admin_user_id', '=', admin.id)
            .where('role_code', '=', roleCode)
            .executeTakeFirst();
          if (assignment !== undefined && assignment.revoked_at !== null) throw conflict();
          if (assignment === undefined)
            await tx
              .insertInto('administration.admin_user_roles')
              .values({
                admin_user_id: admin.id,
                role_code: roleCode,
                assigned_by_admin_id: admin.id,
                revoked_at: null,
                revoked_by_admin_id: null,
              })
              .execute();
        }
        const old = (
          await sql<Pending>`SELECT * FROM administration.admin_totp_enrollments WHERE admin_user_id=${admin.id}::uuid
        AND completed_at IS NULL AND cancelled_at IS NULL FOR UPDATE`.execute(tx)
        ).rows[0];
        if (old !== undefined) {
          const cancelled = await this.audit(tx, input, digest, old.id, 'cancelled', at);
          await sql`UPDATE administration.admin_totp_enrollments SET cancelled_at=${at}::timestamptz,cancellation_audit_id=${cancelled}::uuid WHERE id=${old.id}::uuid`.execute(
            tx,
          );
        }
        const id = randomUUID(),
          expiresAt = new Date(at.getTime() + 600000);
        if (this.disposed) throw unavailable();
        const { secret } = createAdminTotpEnrollment(
          { actorUserId: input.actorUserId, credentialId: id },
          this.encryption,
        );
        const invitationToken = createAdminTotpInvitation(
          { actorUserId: input.actorUserId, credentialId: id },
          input.requestId,
          this.encryption,
        );
        const invitationHash = createHash('sha256').update(invitationToken).digest('hex');
        const auditId = await this.audit(tx, input, digest, id, 'approved', at, roles);
        await this.record(tx, input, digest, 'approve', admin.id, id, auditId, at);
        await sql`INSERT INTO administration.admin_totp_enrollments(id,admin_user_id,admin_version,operator_request_id,invitation_hash,ciphertext,nonce,key_id,key_version,approved_at,expires_at)
        VALUES(${id}::uuid,${admin.id}::uuid,${admin.version},${input.requestId}::uuid,${invitationHash},${Buffer.from(secret.ciphertext)},${Buffer.from(secret.nonce)},
          ${secret.keyId},${secret.keyVersion},${at}::timestamptz,${expiresAt}::timestamptz)`.execute(
          tx,
        );
        return { status: 'pending' as const, invitationToken, expiresAt: expiresAt.toISOString() };
      }),
    );
  }
  public async revokeCredential(
    input: Readonly<{
      actorUserId: string;
      credentialId: string;
      requestId: string;
      reasonCode: AdminTotpOperatorReason;
    }>,
  ): Promise<Readonly<{ status: 'revoked'; replayed: boolean }>> {
    this.validate(input);
    if (!UUID.test(input.credentialId)) throw unavailable();
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          'revoke',
          this.operatorId,
          input.actorUserId.toLowerCase(),
          input.credentialId.toLowerCase(),
          input.reasonCode,
        ]),
      )
      .digest('hex');
    return this.safe(() =>
      this.database.transaction().execute(async (tx) => {
        if ((await this.prior(tx, input.requestId, digest, 'revoke')) !== undefined)
          return { status: 'revoked' as const, replayed: true };
        const admin = (
          await sql<{
            id: string;
          }>`SELECT id FROM administration.admin_users WHERE user_id=${input.actorUserId}::uuid FOR UPDATE`.execute(
            tx,
          )
        ).rows[0];
        if (admin === undefined) throw unavailable();
        const credential = (
          await sql<{ id: string }>`SELECT id FROM administration.admin_totp_credentials
        WHERE id=${input.credentialId}::uuid AND admin_user_id=${admin.id}::uuid AND revoked_at IS NULL FOR UPDATE`.execute(
            tx,
          )
        ).rows[0];
        if (credential === undefined) throw unavailable();
        const at = await adminTotpDatabaseTime(tx);
        const auditId = await this.audit(tx, input, digest, credential.id, 'revoked', at);
        await this.record(tx, input, digest, 'revoke', admin.id, credential.id, auditId, at);
        await sql`UPDATE administration.admin_totp_credentials SET revoked_at=${at}::timestamptz,revocation_audit_id=${auditId}::uuid
        WHERE id=${credential.id}::uuid`.execute(tx);
        const sessions = (
          await sql<{
            id: string;
          }>`UPDATE administration.admin_sessions SET revoked_at=greatest(${at}::timestamptz,issued_at)
        WHERE admin_user_id=${admin.id}::uuid AND revoked_at IS NULL RETURNING id`.execute(tx)
        ).rows;
        for (const session of sessions)
          await this.audit(tx, input, digest, session.id, 'session_revoked', at);
        return { status: 'revoked' as const, replayed: false };
      }),
    );
  }
}
