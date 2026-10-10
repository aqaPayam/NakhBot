import {
  CloudflarePrivateMediaWorker,
  EdgeHmacMediaAudienceAuthenticator,
  EdgeHmacMediaDeliveryTokens,
  EdgeHttpMediaSourceAuthority,
  type PrivateR2Bucket,
} from './edge.js';

type MediaEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface CloudflareR2ObjectBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface CloudflareR2BucketBinding {
  get(key: string): Promise<CloudflareR2ObjectBody | null>;
}

export interface MediaEdgeEnvironment {
  NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED?: string;
  NAKH_MEDIA_ORIGIN: string;
  NAKH_MEDIA_ENVIRONMENT: string;
  NAKH_MEDIA_SIGNING_KEYS: string;
  NAKH_MEDIA_AUDIENCE_KEYS: string;
  NAKH_MEDIA_AUTHORITY_URL: string;
  NAKH_MEDIA_BUCKET: CloudflareR2BucketBinding;
}

export interface MediaEdgeRuntime {
  fetch(request: Request): Promise<Response>;
}

const environments = new Set<MediaEnvironment>(['development', 'test', 'staging', 'production']);

function unavailable(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error('Invalid media edge key ring.');
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let encoded = '';
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const canonical = btoa(encoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    if (canonical !== value || bytes.byteLength < 32 || bytes.byteLength > 64)
      throw new Error('Invalid media edge key ring.');
    return bytes;
  } catch {
    throw new Error('Invalid media edge key ring.');
  }
}

function keyRing(value: string): ReadonlyMap<string, Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid media edge key ring.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Invalid media edge key ring.');
  const entries = Object.entries(parsed as Readonly<Record<string, unknown>>);
  if (entries.length < 1 || entries.length > 3) throw new Error('Invalid media edge key ring.');
  return new Map(entries.map(([keyId, key]) => [keyId, decodeKey(key)]));
}

/** Composes the edge only after explicit activation; disabled mode never reads key material. */
export function createMediaEdge(
  environment: MediaEdgeEnvironment,
  request: typeof fetch = fetch,
): MediaEdgeRuntime {
  const enabled = environment.NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED ?? 'false';
  if (enabled === 'false') return { fetch: () => Promise.resolve(unavailable()) };
  if (enabled !== 'true') throw new Error('Invalid media edge activation flag.');
  if (!environments.has(environment.NAKH_MEDIA_ENVIRONMENT as MediaEnvironment))
    throw new Error('Invalid media edge environment.');
  const mediaEnvironment = environment.NAKH_MEDIA_ENVIRONMENT as MediaEnvironment;
  const signingKeys = keyRing(environment.NAKH_MEDIA_SIGNING_KEYS);
  const audienceKeys = keyRing(environment.NAKH_MEDIA_AUDIENCE_KEYS);
  if (
    [...signingKeys.values()].some((signing) =>
      [...audienceKeys.values()].some(
        (audience) =>
          signing.byteLength === audience.byteLength &&
          signing.every((byte, index) => byte === audience[index]),
      ),
    )
  )
    throw new Error('Media signing and audience keys must differ.');
  const bucket: PrivateR2Bucket = {
    get: async (key) => {
      const object = await environment.NAKH_MEDIA_BUCKET.get(key);
      return object === null ? null : { body: object.body, size: object.size };
    },
  };
  return new CloudflarePrivateMediaWorker({
    origin: environment.NAKH_MEDIA_ORIGIN,
    environment: mediaEnvironment,
    tokens: new EdgeHmacMediaDeliveryTokens(signingKeys),
    audience: new EdgeHmacMediaAudienceAuthenticator(environment.NAKH_MEDIA_ORIGIN, audienceKeys),
    bucket,
    authority: new EdgeHttpMediaSourceAuthority(environment.NAKH_MEDIA_AUTHORITY_URL, request),
  });
}

const runtimes = new WeakMap<object, MediaEdgeRuntime>();

export default {
  async fetch(request: Request, environment: MediaEdgeEnvironment): Promise<Response> {
    try {
      let runtime = runtimes.get(environment);
      if (runtime === undefined) {
        runtime = createMediaEdge(environment);
        runtimes.set(environment, runtime);
      }
      return await runtime.fetch(request);
    } catch {
      return unavailable();
    }
  },
};
