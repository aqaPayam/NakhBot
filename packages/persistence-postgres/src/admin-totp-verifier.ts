import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  AdminSessionService,
  verifyProtectedAdminTotp,
  type AdminMfaProofVerifier,
  type AdminTotpKeyResolver,
  type VerifiedAdminMfaProof,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminSessionStore } from './admin-session-store.js';
import { requireNativeAdminTotp } from './admin-session-policy.js';
import {
  consumeAdminTotpAttempt,
  adminTotpDatabaseTime,
  hasAdminTotpIdentityAndRoles,
} from './admin-totp-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Credential = {
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  key_version: number;
  last_used_step: string;
};
type Proof = { id: string; verified_at: Date; expires_at: Date };

/** Admin row is the shared serialization owner for proof admission, session issuance and enrollment.
 * Trusted database time owns the code window and durable five-attempt/five-minute rate limit. */
export class PostgresAdminTotpVerifier implements AdminMfaProofVerifier {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly keys: AdminTotpKeyResolver,
  ) {}

  public async verify(
    input: Parameters<AdminMfaProofVerifier['verify']>[0],
  ): Promise<VerifiedAdminMfaProof | undefined> {
    if (
      !UUID.test(input.actorUserId) ||
      !UUID.test(input.requestId) ||
      !/^[1-9][0-9]{0,19}$/u.test(input.telegramUserId)
    )
      return undefined;
    return this.database.transaction().execute(async (tx) => {
      const admin = (
        await sql<{ id: string; version: number; telegram_user_id: string; is_active: boolean }>`
        SELECT id,version,telegram_user_id::text,is_active FROM administration.admin_users
        WHERE user_id=${input.actorUserId}::uuid FOR UPDATE`.execute(tx)
      ).rows[0];
      if (
        admin === undefined ||
        !admin.is_active ||
        admin.telegram_user_id !== input.telegramUserId
      )
        return undefined;
      if (!(await hasAdminTotpIdentityAndRoles(tx, admin.id))) return undefined;
      const at = await adminTotpDatabaseTime(tx);
      const budget = await consumeAdminTotpAttempt(tx, admin.id, at);
      const audit = async (
        subjectId: string,
        result: 'verified' | 'rejected' | 'limited',
        auditId = randomUUID(),
      ): Promise<void> => {
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id: auditId,
            category: 'security',
            event_type: `administration.totp-${result}.v1`,
            actor_type: 'user',
            actor_user_id: input.actorUserId,
            actor_admin_id: null,
            subject_type: result === 'verified' ? 'admin_totp_proof' : 'admin_user',
            subject_id: subjectId,
            result_code: result,
            metadata_schema_version: 1,
            metadata: {},
            request_id: input.requestId,
            command_id: randomUUID(),
            occurred_at: at,
          })
          .execute();
      };
      if (!budget) {
        await audit(admin.id, 'limited');
        return undefined;
      }
      const credential = (
        await sql<Credential>`SELECT id,ciphertext,nonce,key_id,key_version,last_used_step
        FROM administration.admin_totp_credentials WHERE admin_user_id=${admin.id}::uuid
        AND revoked_at IS NULL FOR UPDATE`.execute(tx)
      ).rows[0];
      const step =
        credential === undefined
          ? undefined
          : verifyProtectedAdminTotp(
              { actorUserId: input.actorUserId, credentialId: credential.id },
              {
                ciphertext: credential.ciphertext,
                nonce: credential.nonce,
                keyId: credential.key_id,
                keyVersion: credential.key_version,
              },
              this.keys,
              input.proof,
              at,
            );
      if (
        credential === undefined ||
        step === undefined ||
        BigInt(step) < BigInt(credential.last_used_step)
      ) {
        await audit(admin.id, 'rejected');
        return undefined;
      }
      const previous = (
        await sql<Proof>`SELECT id,verified_at,expires_at FROM administration.admin_totp_proofs
        WHERE credential_id=${credential.id}::uuid AND matched_step=${step}::bigint
        AND admin_version=${admin.version} AND expires_at>${at}::timestamptz`.execute(tx)
      ).rows[0];
      let proof = previous;
      if (proof === undefined) {
        // The enrollment-confirmation counter has no proof and must never authorize a session.
        if (BigInt(step) === BigInt(credential.last_used_step)) {
          await audit(admin.id, 'rejected');
          return undefined;
        }
        const id = randomUUID(),
          auditId = randomUUID();
        await sql`UPDATE administration.admin_totp_credentials SET last_used_step=${step}::bigint
          WHERE id=${credential.id}::uuid`.execute(tx);
        await audit(id, 'verified', auditId);
        proof = { id, verified_at: at, expires_at: new Date(at.getTime() + 300_000) };
        await sql`INSERT INTO administration.admin_totp_proofs(id,credential_id,admin_user_id,admin_version,matched_step,verified_at,expires_at,audit_id)
          VALUES(${id}::uuid,${credential.id}::uuid,${admin.id}::uuid,${admin.version},${step}::bigint,
            ${proof.verified_at}::timestamptz,${proof.expires_at}::timestamptz,${auditId}::uuid)`.execute(
          tx,
        );
      }
      return {
        actorUserId: input.actorUserId,
        telegramUserId: input.telegramUserId,
        proofId: proof.id,
        verifiedAt: proof.verified_at,
        expiresAt: proof.expires_at,
        totpCredentialId: credential.id,
      };
    });
  }
}

/** Native composition requires persisted TOTP provenance even if a verifier is accidentally replaced. */
export function createPostgresTotpAdminSessions(
  database: NakhDatabase,
  keys: AdminTotpKeyResolver,
): AdminSessionService {
  requireNativeAdminTotp(database);
  return new AdminSessionService(
    new PostgresAdminSessionStore(database, true),
    new PostgresAdminTotpVerifier(database, keys),
  );
}
