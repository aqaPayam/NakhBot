import {
  invalidMediaGrant,
  parseMediaDeliveryPayload,
  validateMediaDeliveryKeyId,
  type MediaDeliveryClaims,
} from './claims.js';

export type EdgeMediaDeliveryKeyRing = ReadonlyMap<string, Uint8Array>;

function encode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalidMediaGrant();
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encode(bytes) !== value) invalidMediaGrant();
    return bytes;
  } catch {
    invalidMediaGrant();
  }
}

function parse(value: string): Readonly<{ keyId: string; claims: MediaDeliveryClaims }> {
  try {
    return parseMediaDeliveryPayload(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value))) as unknown,
    );
  } catch {
    invalidMediaGrant();
  }
}

export class EdgeHmacMediaDeliveryTokens {
  private readonly keys: ReadonlyMap<string, Uint8Array>;

  public constructor(
    keys: EdgeMediaDeliveryKeyRing,
    private readonly subtle: Pick<typeof crypto.subtle, 'importKey' | 'verify'> = crypto.subtle,
  ) {
    if (keys.size < 1 || keys.size > 3) invalidMediaGrant();
    for (const [keyId, key] of keys) {
      validateMediaDeliveryKeyId(keyId);
      if (key.byteLength < 32 || key.byteLength > 64) invalidMediaGrant();
    }
    this.keys = new Map([...keys].map(([keyId, key]) => [keyId, Uint8Array.from(key)]));
  }

  public async verify(
    token: string,
    expected: Readonly<{ path: string; audienceId: string; now: number }>,
  ): Promise<MediaDeliveryClaims> {
    if (token.length > 2048) invalidMediaGrant();
    const parts = token.split('.');
    if (parts.length !== 2) invalidMediaGrant();
    const parsed = parse(parts[0]!);
    const keyBytes = this.keys.get(parsed.keyId);
    if (keyBytes === undefined) invalidMediaGrant();
    const key = await this.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await this.subtle.verify(
      'HMAC',
      key,
      decode(parts[1]!),
      new TextEncoder().encode(parts[0]),
    );
    if (
      !valid ||
      !Number.isSafeInteger(expected.now) ||
      parsed.claims.path !== expected.path ||
      parsed.claims.audienceId !== expected.audienceId ||
      expected.now < parsed.claims.issuedAt - 5 ||
      expected.now >= parsed.claims.expiresAt
    )
      invalidMediaGrant();
    return parsed.claims;
  }
}

export interface EdgeAudienceAuthenticator {
  authenticate(request: Request): Promise<string | null>;
}

export interface PrivateR2Object {
  body: ReadableStream<Uint8Array> | Uint8Array;
  size: number;
}

export interface PrivateR2Bucket {
  get(key: string): Promise<PrivateR2Object | null>;
}

export type MediaDeliveryEdgeConfig = Readonly<{
  origin: string;
  environment: 'development' | 'test' | 'staging' | 'production';
  tokens: EdgeHmacMediaDeliveryTokens;
  audience: EdgeAudienceAuthenticator;
  bucket: PrivateR2Bucket;
  now?: () => number;
}>;

function unavailable(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function validOrigin(value: string): string {
  const url = new URL(value);
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
  return url.origin;
}

export class CloudflarePrivateMediaWorker {
  private readonly origin: string;
  private readonly now: () => number;

  public constructor(private readonly config: MediaDeliveryEdgeConfig) {
    this.origin = validOrigin(config.origin);
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
  }

  public async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'GET') return unavailable();
      const url = new URL(request.url);
      if (
        url.origin !== this.origin ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== ''
      )
        return unavailable();
      const tokenValues = url.searchParams.getAll('token');
      if (tokenValues.length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'token'))
        return unavailable();
      const audienceId = await this.config.audience.authenticate(request);
      if (audienceId === null) return unavailable();
      const now = this.now();
      const claims = await this.config.tokens.verify(tokenValues[0]!, {
        path: url.pathname,
        audienceId,
        now,
      });
      const assetId = claims.path.split('/')[2]!;
      const filename =
        claims.variant === 'thumbnail' ? 'thumbnail-v1.webp' : 'blurred-preview-v1.webp';
      const object = await this.config.bucket.get(
        `variants/${this.config.environment}/${assetId}/${filename}`,
      );
      if (object === null || !Number.isSafeInteger(object.size) || object.size <= 0)
        return unavailable();
      const moderation = claims.purpose === 'moderation_evidence';
      const remaining = Math.max(0, claims.expiresAt - now);
      return new Response(object.body, {
        status: 200,
        headers: {
          'cache-control': moderation ? 'no-store' : `private, max-age=${String(remaining)}`,
          'content-length': String(object.size),
          'content-security-policy': "default-src 'none'; sandbox",
          'content-type': 'image/webp',
          'cross-origin-resource-policy': 'same-site',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return unavailable();
    }
  }
}
