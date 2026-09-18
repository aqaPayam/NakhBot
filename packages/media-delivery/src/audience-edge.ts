import {
  invalidAudienceCredential,
  mediaAudiencePayload,
  parseMediaAudiencePayload,
  validateAudienceKeyId,
  validateAudienceOrigin,
} from './audience-claims.js';
import type { EdgeAudienceAuthenticator } from './edge.js';

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalidAudienceCredential();
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encode(bytes) !== value) invalidAudienceCredential();
    return bytes;
  } catch {
    invalidAudienceCredential();
  }
}

/** Edge verifier for a gateway-issued audience token, independent of the signed media grant. */
export class EdgeHmacMediaAudienceAuthenticator implements EdgeAudienceAuthenticator {
  private readonly keys: ReadonlyMap<string, Uint8Array>;
  private readonly origin: string;

  public constructor(
    mediaOrigin: string,
    keys: ReadonlyMap<string, Uint8Array>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly subtle: Pick<typeof crypto.subtle, 'importKey' | 'verify'> = crypto.subtle,
  ) {
    this.origin = validateAudienceOrigin(mediaOrigin);
    if (keys.size < 1 || keys.size > 3) invalidAudienceCredential();
    for (const [keyId, key] of keys) {
      validateAudienceKeyId(keyId);
      if (key.byteLength < 32 || key.byteLength > 64) invalidAudienceCredential();
    }
    this.keys = new Map([...keys].map(([keyId, key]) => [keyId, Uint8Array.from(key)]));
  }

  public async authenticate(request: Request): Promise<string | null> {
    try {
      const authorization = request.headers.get('authorization');
      if (authorization === null || !authorization.startsWith('Bearer ')) return null;
      const token = authorization.slice('Bearer '.length);
      if (token.length > 512) return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const payloadBytes = decode(parts[0]!);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
      const parsed = parseMediaAudiencePayload(JSON.parse(decoded) as unknown);
      if (
        encode(new TextEncoder().encode(mediaAudiencePayload(parsed.keyId, parsed.claims))) !==
        parts[0]
      )
        return null;
      const key = this.keys.get(parsed.keyId);
      if (key === undefined) return null;
      const cryptoKey = await this.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      const valid = await this.subtle.verify(
        'HMAC',
        cryptoKey,
        decode(parts[1]!),
        new TextEncoder().encode(parts[0]),
      );
      const now = this.now();
      if (
        !valid ||
        parsed.claims.origin !== this.origin ||
        !Number.isSafeInteger(now) ||
        now < parsed.claims.issuedAt - 5 ||
        now >= parsed.claims.expiresAt
      )
        return null;
      return parsed.claims.audienceId;
    } catch {
      return null;
    }
  }
}
