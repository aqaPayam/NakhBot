import { createHmac, timingSafeEqual } from 'node:crypto';

export type DeliveryPurpose =
  'profile_card' | 'profile_detail' | 'liked_by_blur' | 'owner_preview' | 'moderation_evidence';
export type DeliveryVariant = 'thumbnail' | 'blurred_preview';
export type MediaDeliveryClaims = Readonly<{
  path: string;
  audienceId: string;
  purpose: DeliveryPurpose;
  variant: DeliveryVariant;
  issuedAt: number;
  expiresAt: number;
}>;
export type MediaDeliveryKeyRing = Readonly<{
  currentKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

const id = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const pathPattern = new RegExp(`^/media/${id}/(?:thumbnail-v1|blurred-preview-v1)\\.webp$`, 'u');
const audiencePattern = new RegExp(`^${id}$`, 'u');
const keyIdPattern = /^[a-z][a-z0-9_-]{0,31}$/u;
const purposes = new Set<DeliveryPurpose>([
  'profile_card',
  'profile_detail',
  'liked_by_blur',
  'owner_preview',
  'moderation_evidence',
]);
const variants = new Set<DeliveryVariant>(['thumbnail', 'blurred_preview']);

function invalid(): never {
  throw new Error('media_grant_invalid');
}
function encode(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64url');
}

function validate(claims: MediaDeliveryClaims): void {
  if (
    !pathPattern.test(claims.path) ||
    !audiencePattern.test(claims.audienceId) ||
    !purposes.has(claims.purpose) ||
    !variants.has(claims.variant) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > 300 ||
    (claims.purpose === 'liked_by_blur') !== (claims.variant === 'blurred_preview')
  )
    invalid();
}

function payload(keyId: string, claims: MediaDeliveryClaims): string {
  return JSON.stringify([
    1,
    keyId,
    claims.path,
    claims.audienceId,
    claims.purpose,
    claims.variant,
    claims.issuedAt,
    claims.expiresAt,
  ]);
}

function parse(encoded: string): Readonly<{ keyId: string; claims: MediaDeliveryClaims }> {
  let value: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (encode(decoded) !== encoded) invalid();
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    invalid();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value[0] !== 1 ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string' ||
    typeof value[3] !== 'string' ||
    typeof value[4] !== 'string' ||
    typeof value[5] !== 'string' ||
    typeof value[6] !== 'number' ||
    typeof value[7] !== 'number' ||
    !keyIdPattern.test(value[1])
  )
    invalid();
  const claims = {
    path: value[2],
    audienceId: value[3],
    purpose: value[4],
    variant: value[5],
    issuedAt: value[6],
    expiresAt: value[7],
  } as MediaDeliveryClaims;
  validate(claims);
  return { keyId: value[1], claims };
}

export class HmacMediaDeliveryTokens {
  private readonly ring: MediaDeliveryKeyRing;

  public constructor(ring: MediaDeliveryKeyRing) {
    if (
      !keyIdPattern.test(ring.currentKeyId) ||
      !ring.keys.has(ring.currentKeyId) ||
      ring.keys.size < 1 ||
      ring.keys.size > 3
    )
      invalid();
    for (const [keyId, key] of ring.keys)
      if (!keyIdPattern.test(keyId) || key.byteLength < 32 || key.byteLength > 64) invalid();
    this.ring = {
      currentKeyId: ring.currentKeyId,
      keys: new Map([...ring.keys].map(([keyId, key]) => [keyId, Uint8Array.from(key)])),
    };
  }

  public sign(claims: MediaDeliveryClaims): string {
    validate(claims);
    const encoded = encode(payload(this.ring.currentKeyId, claims));
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
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) invalid();
    const parsed = parse(parts[0]!);
    const key = this.ring.keys.get(parsed.keyId);
    if (key === undefined) invalid();
    const supplied = Buffer.from(parts[1]!, 'base64url');
    if (encode(supplied) !== parts[1]) invalid();
    const actual = createHmac('sha256', key).update(parts[0]!).digest();
    if (supplied.byteLength !== actual.byteLength || !timingSafeEqual(supplied, actual)) invalid();
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
      invalid();
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
      invalid();
    this.origin = url.origin;
  }
  public sign(claims: MediaDeliveryClaims): string {
    const url = new URL(claims.path, this.origin);
    url.searchParams.set('token', this.tokens.sign(claims));
    return url.toString();
  }
}
