import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { ApplicationError } from '@nakh/domain';

export type AccountControlLife = Readonly<{ userId: string; productEpoch: number }>;
export type AccountControlGrant = AccountControlLife &
  Readonly<{
    id: string;
    issuedAt: Date;
    expiresAt: Date;
  }>;
export type AccountControlActor = AccountControlLife &
  Readonly<{ kind: 'user'; scope: 'account_control'; controlGrantId: string }>;
export interface AccountControlSessionStore {
  issue(life: AccountControlLife, requestId: string): Promise<AccountControlGrant | undefined>;
  current(life: AccountControlLife, grantId: string): Promise<AccountControlGrant | undefined>;
  revoke(life: AccountControlLife, grantId: string, requestId: string): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^v1\.ac\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{22})$/u;
const AAD = Buffer.from('nakh-account-control-v1');
export function isAccountControlLife(value: unknown): value is AccountControlLife {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const life = value as Readonly<Record<string, unknown>>;
  return (
    typeof life.userId === 'string' &&
    UUID.test(life.userId) &&
    typeof life.productEpoch === 'number' &&
    Number.isSafeInteger(life.productEpoch) &&
    life.productEpoch >= 0 &&
    life.productEpoch <= 2147483647
  );
}
function unavailable(): ApplicationError {
  return new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
}
/** Limited deletion/Return control only; never a product session.
 * Issuance is server-internal: life must come from trusted primary ingress before
 * its async waits. No HTTP body or previously authenticated actor may select a new epoch.
 * Native immutable grant/expiry/revocation facts, not ciphertext alone, authorize use. */
export class AccountControlSessionService {
  private readonly key: Buffer;
  public constructor(
    private readonly store: AccountControlSessionStore,
    key: Uint8Array,
  ) {
    if (key.byteLength < 32) throw new Error('Account control key is invalid.');
    this.key = createHmac('sha256', key).update('account-control-cipher-v1').digest();
  }
  public async issue(
    life: AccountControlLife,
    requestId: string,
  ): Promise<
    Readonly<{
      accountControlToken: string;
      expiresAt: string;
    }>
  > {
    if (!isAccountControlLife(life) || !UUID.test(requestId)) throw unavailable();
    const frozen = { userId: life.userId, productEpoch: life.productEpoch };
    const grant = await this.store.issue(frozen, requestId);
    if (
      grant === undefined ||
      grant.userId !== frozen.userId ||
      grant.productEpoch !== frozen.productEpoch ||
      !UUID.test(grant.id)
    )
      throw unavailable();
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ version: 1, grantId: grant.id, ...frozen })),
      cipher.final(),
    ]);
    return {
      accountControlToken: `v1.ac.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }
  private decode(token: string): (AccountControlLife & Readonly<{ grantId: string }>) | undefined {
    const match = TOKEN.exec(token);
    if (match === null) return undefined;
    try {
      const parts = match.slice(1).map((value) => Buffer.from(value, 'base64url'));
      if (parts.some((value, index) => value.toString('base64url') !== match[index + 1]))
        return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.key, parts[0]!);
      decipher.setAAD(AAD);
      decipher.setAuthTag(parts[2]!);
      const value: unknown = JSON.parse(
        Buffer.concat([decipher.update(parts[1]!), decipher.final()]).toString('utf8'),
      );
      if (!isAccountControlLife(value) || Object.keys(value).length !== 4) return undefined;
      const data = value as AccountControlLife & Readonly<{ version?: unknown; grantId?: unknown }>;
      if (data.version !== 1 || typeof data.grantId !== 'string' || !UUID.test(data.grantId))
        return undefined;
      return { userId: data.userId, productEpoch: data.productEpoch, grantId: data.grantId };
    } catch {
      return undefined;
    }
  }
  public async authenticate(
    input: Readonly<{ bearerToken: string; audience: 'account_control' }>,
  ): Promise<AccountControlActor | undefined> {
    if (input.audience !== 'account_control') return undefined;
    const original = this.decode(input.bearerToken);
    if (original === undefined) return undefined;
    const grant = await this.store.current(original, original.grantId);
    if (
      grant === undefined ||
      grant.userId !== original.userId ||
      grant.productEpoch !== original.productEpoch ||
      grant.id !== original.grantId
    )
      return undefined;
    return Object.freeze({
      kind: 'user',
      scope: 'account_control',
      userId: original.userId,
      productEpoch: original.productEpoch,
      controlGrantId: original.grantId,
    });
  }
  public async revoke(life: AccountControlLife, token: string, requestId: string): Promise<void> {
    const original = this.decode(token);
    if (
      !isAccountControlLife(life) ||
      !UUID.test(requestId) ||
      original === undefined ||
      original.userId !== life.userId ||
      original.productEpoch !== life.productEpoch
    )
      throw unavailable();
    await this.store.revoke(
      { userId: life.userId, productEpoch: life.productEpoch },
      original.grantId,
      requestId,
    );
  }
}
