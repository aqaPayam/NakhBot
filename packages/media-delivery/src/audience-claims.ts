export type MediaAudienceClaims = Readonly<{
  origin: string;
  audienceId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}>;

const AUDIENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const NONCE = /^[A-Za-z0-9_-]{16}$/u;

export function invalidAudienceCredential(): never {
  throw new Error('media_audience_credential_invalid');
}

export function validateAudienceKeyId(keyId: string): void {
  if (!KEY_ID.test(keyId)) invalidAudienceCredential();
}

export function validateAudienceOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== origin
    )
      invalidAudienceCredential();
    return origin;
  } catch {
    invalidAudienceCredential();
  }
}

export function validateAudienceClaims(claims: MediaAudienceClaims): void {
  validateAudienceOrigin(claims.origin);
  if (
    !AUDIENCE_ID.test(claims.audienceId) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    claims.issuedAt < 0 ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt - claims.issuedAt < 10 ||
    claims.expiresAt - claims.issuedAt > 120 ||
    !NONCE.test(claims.nonce)
  )
    invalidAudienceCredential();
}

export function mediaAudiencePayload(keyId: string, claims: MediaAudienceClaims): string {
  validateAudienceKeyId(keyId);
  validateAudienceClaims(claims);
  return JSON.stringify([
    'media-audience-v1',
    keyId,
    claims.origin,
    claims.audienceId,
    claims.issuedAt,
    claims.expiresAt,
    claims.nonce,
  ]);
}

export function parseMediaAudiencePayload(value: unknown): Readonly<{
  keyId: string;
  claims: MediaAudienceClaims;
}> {
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[0] !== 'media-audience-v1' ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string' ||
    typeof value[3] !== 'string' ||
    typeof value[4] !== 'number' ||
    typeof value[5] !== 'number' ||
    typeof value[6] !== 'string'
  )
    invalidAudienceCredential();
  const keyId = value[1];
  const claims = {
    origin: value[2],
    audienceId: value[3],
    issuedAt: value[4],
    expiresAt: value[5],
    nonce: value[6],
  };
  validateAudienceKeyId(keyId);
  validateAudienceClaims(claims);
  return { keyId, claims };
}
