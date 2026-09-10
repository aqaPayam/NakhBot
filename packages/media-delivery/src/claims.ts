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

export function invalidMediaGrant(): never {
  throw new Error('media_grant_invalid');
}

export function validateMediaDeliveryKeyId(keyId: string): void {
  if (!keyIdPattern.test(keyId)) invalidMediaGrant();
}

export function validateMediaDeliveryClaims(claims: MediaDeliveryClaims): void {
  if (
    !pathPattern.test(claims.path) ||
    !audiencePattern.test(claims.audienceId) ||
    !purposes.has(claims.purpose) ||
    !variants.has(claims.variant) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > 300 ||
    claims.path.endsWith('/blurred-preview-v1.webp') !== (claims.variant === 'blurred_preview') ||
    (claims.purpose === 'liked_by_blur') !== (claims.variant === 'blurred_preview')
  )
    invalidMediaGrant();
}

export function mediaDeliveryPayload(keyId: string, claims: MediaDeliveryClaims): string {
  validateMediaDeliveryKeyId(keyId);
  validateMediaDeliveryClaims(claims);
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

export function parseMediaDeliveryPayload(value: unknown): Readonly<{
  keyId: string;
  claims: MediaDeliveryClaims;
}> {
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
    typeof value[7] !== 'number'
  )
    invalidMediaGrant();
  validateMediaDeliveryKeyId(value[1]);
  const claims = {
    path: value[2],
    audienceId: value[3],
    purpose: value[4],
    variant: value[5],
    issuedAt: value[6],
    expiresAt: value[7],
  } as MediaDeliveryClaims;
  validateMediaDeliveryClaims(claims);
  return { keyId: value[1], claims };
}
