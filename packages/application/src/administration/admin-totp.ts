import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_MS = 30_000;

/** RFC 6238 time counter, independent of the process clock. The caller supplies trusted time. */
export function adminTotpStep(at: Date): number {
  const time = at.getTime();
  if (!Number.isFinite(time) || time < 0) throw new Error('Invalid MFA time.');
  return Math.floor(time / PERIOD_MS);
}

/** HMAC-SHA1, 30 seconds. Eight digits exist only for the published RFC test vectors. */
export function adminTotpCode(secret: Uint8Array, at: Date, digits: 6 | 8 = 6): string {
  if (secret.byteLength !== 20 || (digits !== 6 && digits !== 8))
    throw new Error('Invalid MFA parameters.');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(adminTotpStep(at)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[19]! & 15;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
  return (truncated % 10 ** digits).toString().padStart(digits, '0');
}

/** Returns the exact matched counter. Native storage must atomically reject reused counters. */
export function matchAdminTotpCode(secret: Uint8Array, code: string, at: Date): number | undefined {
  const current = adminTotpStep(at);
  if (!/^[0-9]{6}$/u.test(code)) return undefined;
  const candidate = Buffer.from(code, 'ascii');
  let match: number | undefined;
  // Compare every admissible window, even after a match. Prefer the latest matching counter.
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const expected = Buffer.from(adminTotpCode(secret, new Date(step * PERIOD_MS)), 'ascii');
    if (timingSafeEqual(candidate, expected)) match = step;
  }
  return match;
}

export type AdminTotpSubject = Readonly<{ actorUserId: string; credentialId: string }>;
export type ProtectedAdminTotpSecret = Readonly<{
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyId: string;
  keyVersion: number;
}>;
export type AdminTotpEncryptionKey = Readonly<{
  keyId: string;
  keyVersion: number;
  key: Uint8Array;
}>;
export interface AdminTotpKeyResolver {
  /** Trusted secret-management capability. Return a copy the caller may clear. */
  resolve(keyId: string, keyVersion: number): Uint8Array | undefined;
}

function aad(subject: AdminTotpSubject, keyId: string, keyVersion: number): Buffer {
  if (
    !UUID.test(subject.actorUserId) ||
    !UUID.test(subject.credentialId) ||
    !/^[A-Za-z0-9_-]{8,160}$/u.test(keyId) ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion < 1
  )
    throw new Error('Invalid MFA secret binding.');
  return Buffer.from(
    JSON.stringify([
      'admin-totp-secret',
      1,
      subject.actorUserId.toLowerCase(),
      subject.credentialId.toLowerCase(),
      keyId,
      keyVersion,
    ]),
  );
}

/** An enrollment URI is a secret: deliver it only through the authenticated enrollment channel. */
export function createAdminTotpEnrollment(
  subject: AdminTotpSubject,
  encryption: AdminTotpEncryptionKey,
): Readonly<{ secret: ProtectedAdminTotpSecret; enrollmentUri: string }> {
  const binding = aad(subject, encryption.keyId, encryption.keyVersion);
  if (encryption.key.byteLength !== 32) throw new Error('Invalid MFA encryption configuration.');
  const key = Buffer.from(encryption.key);
  const seed = randomBytes(20);
  try {
    // A 160-bit seed encodes to exactly 32 Base32 characters, without padding.
    let encoded = '';
    let bits = 0;
    let value = 0;
    for (const byte of seed) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        encoded += BASE32[(value >>> bits) & 31];
      }
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(binding);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final(), cipher.getAuthTag()]);
    const label = encodeURIComponent(`NakhBot:${subject.credentialId.toLowerCase()}`);
    return {
      secret: { ciphertext, nonce, keyId: encryption.keyId, keyVersion: encryption.keyVersion },
      enrollmentUri: `otpauth://totp/${label}?secret=${encoded}&issuer=NakhBot&algorithm=SHA1&digits=6&period=30`,
    };
  } finally {
    seed.fill(0);
    key.fill(0);
  }
}

/** Decrypts only for verification; never returns plaintext to the host or a persistence port. */
export function verifyProtectedAdminTotp(
  subject: AdminTotpSubject,
  secret: ProtectedAdminTotpSecret,
  resolver: AdminTotpKeyResolver,
  code: string,
  at: Date,
): number | undefined {
  const binding = aad(subject, secret.keyId, secret.keyVersion);
  if (secret.nonce.byteLength !== 12 || secret.ciphertext.byteLength !== 36)
    throw new Error('MFA secret is unavailable.');
  const key = resolver.resolve(secret.keyId, secret.keyVersion);
  if (key === undefined) throw new Error('MFA secret is unavailable.');
  let seed: Buffer | undefined;
  try {
    if (key.byteLength !== 32) throw new Error('Invalid key.');
    const encrypted = Buffer.from(secret.ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', key, secret.nonce);
    decipher.setAAD(binding);
    decipher.setAuthTag(encrypted.subarray(20));
    seed = Buffer.concat([decipher.update(encrypted.subarray(0, 20)), decipher.final()]);
    return matchAdminTotpCode(seed, code, at);
  } catch {
    throw new Error('MFA secret is unavailable.');
  } finally {
    seed?.fill(0);
    key.fill(0);
  }
}
