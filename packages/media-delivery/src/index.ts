import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  invalidMediaGrant,
  mediaDeliveryPayload,
  parseMediaDeliveryPayload,
  validateMediaDeliveryClaims,
  validateMediaDeliveryKeyId,
  type MediaDeliveryClaims,
} from './claims.js';

export type { DeliveryPurpose, DeliveryVariant, MediaDeliveryClaims } from './claims.js';

export type MediaDeliveryKeyRing = Readonly<{
  currentKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

function encode(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64url');
}

function parse(encoded: string): Readonly<{ keyId: string; claims: MediaDeliveryClaims }> {
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (encode(decoded) !== encoded) invalidMediaGrant();
    return parseMediaDeliveryPayload(JSON.parse(decoded.toString('utf8')) as unknown);
  } catch {
    invalidMediaGrant();
  }
}

export class HmacMediaDeliveryTokens {
  private readonly ring: MediaDeliveryKeyRing;

  public constructor(ring: MediaDeliveryKeyRing) {
    validateMediaDeliveryKeyId(ring.currentKeyId);
    if (!ring.keys.has(ring.currentKeyId) || ring.keys.size < 1 || ring.keys.size > 3)
      invalidMediaGrant();
    for (const [keyId, key] of ring.keys) {
      validateMediaDeliveryKeyId(keyId);
      if (key.byteLength < 32 || key.byteLength > 64) invalidMediaGrant();
    }
    this.ring = {
      currentKeyId: ring.currentKeyId,
      keys: new Map([...ring.keys].map(([keyId, key]) => [keyId, Uint8Array.from(key)])),
    };
  }

  public sign(claims: MediaDeliveryClaims): string {
    validateMediaDeliveryClaims(claims);
    const encoded = encode(mediaDeliveryPayload(this.ring.currentKeyId, claims));
    const signature = createHmac('sha256', this.ring.keys.get(this.ring.currentKeyId)!)
      .update(encoded)
      .digest();
    return `${encoded}.${encode(signature)}`;
  }

  public verify(
    token: string,
    expected: Readonly<{
      path: string;
      audienceId: string;
      now: number;
      clockSkewSeconds?: number;
    }>,
  ): MediaDeliveryClaims {
    const parts = token.split('.');
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) invalidMediaGrant();
    const parsed = parse(parts[0]!);
    const key = this.ring.keys.get(parsed.keyId);
    if (key === undefined) invalidMediaGrant();
    const supplied = Buffer.from(parts[1]!, 'base64url');
    if (encode(supplied) !== parts[1]) invalidMediaGrant();
    const actual = createHmac('sha256', key).update(parts[0]!).digest();
    if (supplied.byteLength !== actual.byteLength || !timingSafeEqual(supplied, actual))
      invalidMediaGrant();
    const skew = expected.clockSkewSeconds ?? 5;
    if (
      !Number.isSafeInteger(expected.now) ||
      !Number.isSafeInteger(skew) ||
      skew < 0 ||
      skew > 30 ||
      parsed.claims.path !== expected.path ||
      parsed.claims.audienceId !== expected.audienceId ||
      expected.now < parsed.claims.issuedAt - skew ||
      expected.now >= parsed.claims.expiresAt
    )
      invalidMediaGrant();
    return parsed.claims;
  }
}

export class MediaDeliveryUrlSigner {
  private readonly origin: string;
  public constructor(
    origin: string,
    private readonly tokens: HmacMediaDeliveryTokens,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    )
      invalidMediaGrant();
    this.origin = url.origin;
  }
  public sign(claims: MediaDeliveryClaims): string {
    const url = new URL(claims.path, this.origin);
    url.searchParams.set('token', this.tokens.sign(claims));
    return url.toString();
  }
}
