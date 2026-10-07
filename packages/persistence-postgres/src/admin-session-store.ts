import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  AdminSessionService,
  type AdminMfaProofVerifier,
  type AdminSessionStore,
  type CurrentAdminSession,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { nativeAdminTotpRequired, requireNativeAdminSessions } from './admin-session-policy.js';
type Identity = { id: string; user_id: string; telegram_user_id: string; version: number };
type Session = {
  id: string;
  admin_user_id: string;
  admin_version: number;
  expires_at: Date;
  mfa_expires_at: Date;
  revoked_at: Date | null;
  issued_at: Date;
};
/** Only hashes and bounded verification times are retained; factor proof and bearer never enter SQL. */
export class PostgresAdminSessionStore implements AdminSessionStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly requireTotp = false,
  ) {}
  private async audit(
    database: NakhDatabase,
    sessionId: string,
    adminId: string,
    requestId: string,
    event: 'issued' | 'revoked' | 'superseded',
    at: Date,
  ): Promise<void> {
    await database
      .insertInto('platform.audit_logs')
      .values({
        id: randomUUID(),
        category: 'security',
        event_type: `administration.session-${event}.v1`,
        actor_type: 'admin',
        actor_admin_id: adminId,
        actor_user_id: null,
        subject_type: 'admin_session',
        subject_id: sessionId,
        result_code: event,
        metadata_schema_version: 1,
        metadata: {},
        request_id: requestId,
        command_id: randomUUID(),
        occurred_at: at,
      })
      .execute();
  }
  public async issue(
    input: Parameters<AdminSessionStore['issue']>[0],
  ): Promise<CurrentAdminSession | undefined> {
    if (
      input.proof.actorUserId !== input.actorUserId ||
      input.proof.telegramUserId !== input.telegramUserId
    )
      return undefined;
    return this.database.transaction().execute(async (tx) => {
      const admin = (
        await sql<Identity>`SELECT id,user_id,telegram_user_id::text,version FROM administration.admin_users WHERE user_id=${input.actorUserId}::uuid FOR UPDATE`.execute(
          tx,
        )
      ).rows[0];
      if (admin === undefined || admin.telegram_user_id !== input.telegramUserId) return undefined;
      const facts = await new PostgresAdminAuthorizationStore(tx).loadByTelegramIdentity({
        actorUserId: input.actorUserId,
        telegramUserId: input.telegramUserId,
      });
      if (facts === undefined || !facts.adminActive || facts.activePermissions.length === 0)
        return undefined;
      const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx)).rows[0]!.at;
      const verified = input.proof.verifiedAt,
        expiry = new Date(Math.min(input.proof.expiresAt.getTime(), verified.getTime() + 300000));
      if (verified.getTime() > at.getTime() || expiry.getTime() <= at.getTime()) return undefined;
      if (
        (this.requireTotp || nativeAdminTotpRequired(this.database)) &&
        input.proof.totpCredentialId === undefined
      )
        return undefined;
      if (input.proof.totpCredentialId !== undefined) {
        const currentProof = (
          await sql`SELECT proof.id FROM administration.admin_totp_proofs proof
          JOIN administration.admin_totp_credentials credential ON credential.id=proof.credential_id
          WHERE proof.id=${input.proof.proofId}::uuid AND proof.credential_id=${input.proof.totpCredentialId}::uuid
          AND proof.admin_user_id=${admin.id}::uuid AND proof.admin_version=${admin.version}
          AND proof.verified_at=${verified}::timestamptz AND proof.expires_at=${expiry}::timestamptz
          AND credential.last_used_step=proof.matched_step
          AND credential.revoked_at IS NULL`.execute(tx)
        ).rows[0];
        if (currentProof === undefined) return undefined;
      }
      // Serialize proof admission and supersession on the verified admin, reject reused proof globally.
      const used = (
        await sql`SELECT id FROM administration.admin_sessions WHERE mfa_proof_id=${input.proof.proofId}::uuid`.execute(
          tx,
        )
      ).rows;
      if (used.length !== 0) return undefined;
      const previous = (
        await sql<Session>`UPDATE administration.admin_sessions SET revoked_at=greatest(${at}::timestamptz,issued_at) WHERE admin_user_id=${admin.id}::uuid AND revoked_at IS NULL RETURNING *`.execute(
          tx,
        )
      ).rows;
      for (const row of previous)
        await this.audit(tx, row.id, admin.id, input.requestId, 'superseded', at);
      const sessionId = randomUUID(),
        expiresAt = new Date(at.getTime() + 900000);
      const inserted = (
        await sql`INSERT INTO administration.admin_sessions(id,admin_user_id,admin_version,token_hash,mfa_proof_id,issued_at,expires_at,mfa_verified_at,mfa_expires_at,totp_credential_id)
        VALUES (${sessionId}::uuid,${admin.id}::uuid,${admin.version},${input.tokenHash},${input.proof.proofId}::uuid,${at}::timestamptz,${expiresAt}::timestamptz,${verified}::timestamptz,${expiry}::timestamptz,${input.proof.totpCredentialId ?? null}::uuid)
        ON CONFLICT (mfa_proof_id) DO NOTHING RETURNING id`.execute(tx)
      ).rows;
      if (inserted.length !== 1) throw new Error('Admin session admission unavailable.');
      await this.audit(tx, sessionId, admin.id, input.requestId, 'issued', at);
      return {
        actor: { kind: 'admin', userId: admin.user_id },
        telegramUserId: admin.telegram_user_id,
        locale: 'en',
        expiresAt,
        mfaExpiresAt: expiry,
      };
    });
  }
  public async current(
    input: Parameters<AdminSessionStore['current']>[0],
  ): Promise<CurrentAdminSession | undefined> {
    if ((input.tokenHash === undefined) === (input.telegramUserId === undefined)) return undefined;
    const row = (
      await sql<
        Identity & Session
      >`SELECT admin.id,admin.user_id,admin.telegram_user_id::text,admin.version,
      session.admin_user_id,session.admin_version,session.expires_at,session.mfa_expires_at,session.revoked_at,session.issued_at
      FROM administration.admin_sessions session JOIN administration.admin_users admin ON admin.id=session.admin_user_id
      JOIN identity.telegram_identities identity ON identity.user_id=admin.user_id AND identity.telegram_user_id=admin.telegram_user_id
      LEFT JOIN administration.admin_totp_credentials credential ON credential.id=session.totp_credential_id
      WHERE ${input.tokenHash === undefined ? sql`admin.telegram_user_id=${input.telegramUserId}::bigint` : sql`session.token_hash=${input.tokenHash}`}
      AND session.revoked_at IS NULL AND admin.is_active AND admin.identity_verified_at IS NOT NULL
      AND session.admin_version=admin.version AND session.expires_at>statement_timestamp() AND session.mfa_expires_at>statement_timestamp()
      AND (session.totp_credential_id IS NULL OR (credential.id IS NOT NULL AND credential.revoked_at IS NULL))
      AND ${this.requireTotp || nativeAdminTotpRequired(this.database) ? sql`session.totp_credential_id IS NOT NULL` : sql`true`}
      AND EXISTS(SELECT 1 FROM administration.admin_user_roles assignment
        JOIN administration.admin_roles role ON role.code=assignment.role_code AND role.is_active
        JOIN administration.admin_role_permissions permission ON permission.role_code=role.code
        WHERE assignment.admin_user_id=admin.id AND assignment.revoked_at IS NULL)
      LIMIT 1`.execute(this.database)
    ).rows[0];
    return row === undefined
      ? undefined
      : {
          actor: { kind: 'admin', userId: row.user_id },
          telegramUserId: row.telegram_user_id,
          locale: 'en',
          expiresAt: row.expires_at,
          mfaExpiresAt: row.mfa_expires_at,
        };
  }
  public async revoke(input: Parameters<AdminSessionStore['revoke']>[0]): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      const admin = (
        await sql<Identity>`SELECT id,user_id,telegram_user_id::text,version FROM administration.admin_users WHERE user_id=${input.actorUserId}::uuid FOR UPDATE`.execute(
          tx,
        )
      ).rows[0];
      if (admin === undefined) return;
      const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx)).rows[0]!.at;
      const revoked = (
        await sql<Session>`UPDATE administration.admin_sessions SET revoked_at=greatest(${at}::timestamptz,issued_at) WHERE admin_user_id=${admin.id}::uuid AND token_hash=${input.tokenHash} AND revoked_at IS NULL RETURNING *`.execute(
          tx,
        )
      ).rows;
      for (const row of revoked)
        await this.audit(tx, row.id, admin.id, input.requestId, 'revoked', at);
    });
  }
}
export function createPostgresAdminSessions(
  database: NakhDatabase,
  mfa: AdminMfaProofVerifier,
): AdminSessionService {
  requireNativeAdminSessions(database);
  return new AdminSessionService(new PostgresAdminSessionStore(database), mfa);
}
