import { createHash, randomBytes } from 'node:crypto';
import { ApplicationError, type Actor } from '@nakh/domain';

export type VerifiedAdminMfaProof = Readonly<{
  actorUserId: string;
  telegramUserId: string;
  proofId: string;
  verifiedAt: Date;
  expiresAt: Date;
}>;
export interface AdminMfaProofVerifier {
  /** Trusted factor provider: verifies the factor, binds both identities, returns a stable one-use proof ID.
   * Client-supplied expiry/identity and a newly generated ID on each validation are forbidden. */
  verify(
    input: Readonly<{ actorUserId: string; telegramUserId: string; proof: string }>,
  ): Promise<VerifiedAdminMfaProof | undefined>;
}
export type CurrentAdminSession = Readonly<{
  actor: Actor & { kind: 'admin' };
  telegramUserId: string;
  locale: string;
  expiresAt: Date;
  mfaExpiresAt: Date;
}>;
export interface AdminSessionStore {
  issue(
    input: Readonly<{
      actorUserId: string;
      telegramUserId: string;
      requestId: string;
      tokenHash: string;
      proof: VerifiedAdminMfaProof;
    }>,
  ): Promise<CurrentAdminSession | undefined>;
  current(
    input: Readonly<{ tokenHash?: string; telegramUserId?: string }>,
  ): Promise<CurrentAdminSession | undefined>;
  revoke(
    input: Readonly<{ actorUserId: string; tokenHash: string; requestId: string }>,
  ): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TELEGRAM = /^[1-9][0-9]{0,19}$/u;
const TOKEN = /^v1\.as\.[A-Za-z0-9_-]{43}$/u;
function unauthorized(): ApplicationError {
  return new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
}
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Concrete server-owned opaque sessions. Expiry and current RBAC are authoritative in the store. */
export class AdminSessionService {
  public constructor(
    private readonly store: AdminSessionStore,
    private readonly mfa: AdminMfaProofVerifier,
  ) {}
  public async issue(
    input: Readonly<{ actor: Actor; telegramUserId: string; requestId: string; proof: string }>,
  ): Promise<Readonly<{ adminSessionToken: string; expiresAt: string; mfaExpiresAt: string }>> {
    if (
      input.actor.kind !== 'user' ||
      !UUID.test(input.actor.userId) ||
      !TELEGRAM.test(input.telegramUserId) ||
      !UUID.test(input.requestId) ||
      typeof input.proof !== 'string' ||
      input.proof.length < 1 ||
      input.proof.length > 4096
    )
      throw unauthorized();
    let proof: VerifiedAdminMfaProof | undefined;
    try {
      proof = await this.mfa.verify({
        actorUserId: input.actor.userId,
        telegramUserId: input.telegramUserId,
        proof: input.proof,
      });
    } catch {
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
    if (
      proof === undefined ||
      proof.actorUserId !== input.actor.userId ||
      proof.telegramUserId !== input.telegramUserId ||
      !UUID.test(proof.proofId) ||
      !(proof.verifiedAt instanceof Date) ||
      !(proof.expiresAt instanceof Date) ||
      !Number.isFinite(proof.verifiedAt.getTime()) ||
      !Number.isFinite(proof.expiresAt.getTime())
    )
      throw unauthorized();
    const adminSessionToken = `v1.as.${randomBytes(32).toString('base64url')}`;
    const current = await this.store.issue({
      actorUserId: input.actor.userId,
      telegramUserId: input.telegramUserId,
      requestId: input.requestId,
      tokenHash: hash(adminSessionToken),
      proof,
    });
    if (current === undefined) throw unauthorized();
    return {
      adminSessionToken,
      expiresAt: current.expiresAt.toISOString(),
      mfaExpiresAt: current.mfaExpiresAt.toISOString(),
    };
  }
  public authenticate(
    input: Readonly<{ bearerToken: string; audience: 'user' | 'admin' }>,
  ): Promise<CurrentAdminSession['actor'] | undefined> {
    if (input.audience !== 'admin' || !TOKEN.test(input.bearerToken))
      return Promise.resolve(undefined);
    return this.store
      .current({ tokenHash: hash(input.bearerToken) })
      .then((session) => session?.actor);
  }
  public current(telegramUserId: string): Promise<CurrentAdminSession | undefined> {
    return TELEGRAM.test(telegramUserId)
      ? this.store.current({ telegramUserId })
      : Promise.resolve(undefined);
  }
  public async revoke(
    input: Readonly<{ actor: Actor; adminSessionToken: string; requestId: string }>,
  ): Promise<void> {
    if (
      input.actor.kind !== 'admin' ||
      !UUID.test(input.actor.userId) ||
      !TOKEN.test(input.adminSessionToken) ||
      !UUID.test(input.requestId)
    )
      throw unauthorized();
    await this.store.revoke({
      actorUserId: input.actor.userId,
      tokenHash: hash(input.adminSessionToken),
      requestId: input.requestId,
    });
  }
}
