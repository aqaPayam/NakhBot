import { config as loadDotEnv } from 'dotenv';
import { Ajv2020 as Ajv, type ErrorObject } from 'ajv/dist/2020.js';
import { Type, type Static } from '@sinclair/typebox';

const EnvironmentSchema = Type.Union([
  Type.Literal('local'),
  Type.Literal('test'),
  Type.Literal('staging'),
  Type.Literal('production'),
]);

const ConfigSchema = Type.Object(
  {
    environment: EnvironmentSchema,
    serviceName: Type.String({ minLength: 1, maxLength: 64 }),
    release: Type.String({ minLength: 1, maxLength: 128 }),
    http: Type.Object({
      host: Type.String({ minLength: 1 }),
      port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    }),
    database: Type.Object({
      url: Type.String({ minLength: 1 }),
      poolMax: Type.Integer({ minimum: 1, maximum: 100 }),
      statementTimeoutMs: Type.Integer({ minimum: 100, maximum: 120_000 }),
      lockTimeoutMs: Type.Integer({ minimum: 50, maximum: 30_000 }),
    }),
    redis: Type.Object({
      url: Type.String({ minLength: 1 }),
      queuePrefix: Type.String({ minLength: 1, maxLength: 80 }),
    }),
    telegram: Type.Object({
      botTokenRef: Type.String({ minLength: 1 }),
      webhookSecret: Type.String({ minLength: 32 }),
      actionTokenKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      likedByDeliveryEnabled: Type.Boolean(),
      notificationDeliveryEnabled: Type.Boolean(),
    }),
    media: Type.Object({
      ingestionEnabled: Type.Boolean(),
      cachePurgeEnabled: Type.Boolean(),
      cleanupEnabled: Type.Boolean(),
      orphanReconciliationEnabled: Type.Boolean(),
      orphanGraceMs: Type.Integer({ minimum: 3_600_000, maximum: 2_592_000_000 }),
      r2Endpoint: Type.String({ minLength: 1 }),
      bucket: Type.String({ minLength: 1 }),
      accessKeyRef: Type.String({ minLength: 1 }),
      secretKeyRef: Type.String({ minLength: 1 }),
      cleanupAccessKeyRef: Type.String({ minLength: 1 }),
      cleanupSecretKeyRef: Type.String({ minLength: 1 }),
      cdnHost: Type.String({ minLength: 1 }),
      signingKeyId: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
      signingKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      audienceKeyId: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
      audienceKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      cloudflareZoneId: Type.String({ minLength: 1, maxLength: 64 }),
      cloudflareApiTokenRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      transportKeyId: Type.String({ pattern: '^[A-Za-z0-9_-]{1,32}$' }),
      transportKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      clamavHost: Type.String({ pattern: '^[A-Za-z0-9.-]{1,253}$' }),
      clamavPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
      clamavTimeoutMs: Type.Integer({ minimum: 100, maximum: 120_000 }),
    }),
    telemetry: Type.Object({
      enabled: Type.Boolean(),
      exporterEndpoint: Type.String({ minLength: 1 }),
    }),
  },
  { additionalProperties: false },
);

export type AppConfig = Readonly<Static<typeof ConfigSchema>>;

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Configuration boolean values must be true or false.');
}

function required(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required configuration value: ${name}`);
  }
  return value;
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const candidate = {
    environment: required(env, 'NAKH_ENV', 'local'),
    serviceName: required(env, 'NAKH_SERVICE_NAME'),
    release: required(env, 'NAKH_RELEASE', 'dev'),
    http: {
      host: required(env, 'NAKH_HTTP_HOST', '0.0.0.0'),
      port: integer(env.NAKH_HTTP_PORT, 3000),
    },
    database: {
      url: required(env, 'NAKH_DATABASE_URL'),
      poolMax: integer(env.NAKH_DATABASE_POOL_MAX, 10),
      statementTimeoutMs: integer(env.NAKH_DATABASE_STATEMENT_TIMEOUT_MS, 5_000),
      lockTimeoutMs: integer(env.NAKH_DATABASE_LOCK_TIMEOUT_MS, 1_000),
    },
    redis: {
      url: required(env, 'NAKH_REDIS_URL'),
      queuePrefix: required(env, 'NAKH_QUEUE_PREFIX', 'nakh-local'),
    },
    telegram: {
      botTokenRef: required(env, 'NAKH_TELEGRAM_BOT_TOKEN_REF'),
      webhookSecret: required(env, 'NAKH_TELEGRAM_WEBHOOK_SECRET'),
      actionTokenKeyRef: required(
        env,
        'NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF',
        'NAKH_TELEGRAM_ACTION_TOKEN_KEY',
      ),
      likedByDeliveryEnabled: boolean(env.NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED, false),
      notificationDeliveryEnabled: boolean(env.NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED, false),
    },
    media: {
      ingestionEnabled: boolean(env.NAKH_MEDIA_INGESTION_ENABLED, false),
      cachePurgeEnabled: boolean(env.NAKH_MEDIA_CACHE_PURGE_ENABLED, false),
      cleanupEnabled: boolean(env.NAKH_MEDIA_CLEANUP_ENABLED, false),
      orphanReconciliationEnabled: boolean(env.NAKH_MEDIA_ORPHAN_RECONCILIATION_ENABLED, false),
      orphanGraceMs: integer(env.NAKH_MEDIA_ORPHAN_GRACE_MS, 86_400_000),
      r2Endpoint: required(env, 'NAKH_R2_ENDPOINT'),
      bucket: required(env, 'NAKH_R2_BUCKET'),
      accessKeyRef: required(env, 'NAKH_R2_ACCESS_KEY_REF'),
      secretKeyRef: required(env, 'NAKH_R2_SECRET_KEY_REF'),
      cleanupAccessKeyRef: required(
        env,
        'NAKH_R2_CLEANUP_ACCESS_KEY_REF',
        required(env, 'NAKH_R2_ACCESS_KEY_REF'),
      ),
      cleanupSecretKeyRef: required(
        env,
        'NAKH_R2_CLEANUP_SECRET_KEY_REF',
        required(env, 'NAKH_R2_SECRET_KEY_REF'),
      ),
      cdnHost: required(env, 'NAKH_MEDIA_CDN_HOST'),
      signingKeyId: required(env, 'NAKH_MEDIA_SIGNING_KEY_ID', 'media-v1'),
      signingKeyRef: required(env, 'NAKH_MEDIA_SIGNING_KEY_REF'),
      audienceKeyId: required(env, 'NAKH_MEDIA_AUDIENCE_KEY_ID', 'audience-v1'),
      audienceKeyRef: required(env, 'NAKH_MEDIA_AUDIENCE_KEY_REF', 'NAKH_MEDIA_AUDIENCE_KEY'),
      cloudflareZoneId: required(env, 'NAKH_CLOUDFLARE_ZONE_ID', 'disabled'),
      cloudflareApiTokenRef: required(
        env,
        'NAKH_CLOUDFLARE_API_TOKEN_REF',
        'NAKH_CLOUDFLARE_API_TOKEN',
      ),
      transportKeyId: required(env, 'NAKH_MEDIA_TRANSPORT_KEY_ID', 'active-v1'),
      transportKeyRef: required(env, 'NAKH_MEDIA_TRANSPORT_KEY_REF', 'NAKH_MEDIA_TRANSPORT_KEY'),
      clamavHost: required(env, 'NAKH_CLAMAV_HOST', 'clamav'),
      clamavPort: integer(env.NAKH_CLAMAV_PORT, 3310),
      clamavTimeoutMs: integer(env.NAKH_CLAMAV_TIMEOUT_MS, 60_000),
    },
    telemetry: {
      enabled: boolean(env.NAKH_OTEL_ENABLED, false),
      exporterEndpoint: required(env, 'NAKH_OTEL_EXPORTER_ENDPOINT', 'http://localhost:4318'),
    },
  };

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(ConfigSchema);
  if (!validate(candidate)) {
    throw new Error(`Invalid configuration: ${describeErrors(validate.errors)}`);
  }
  if (
    candidate.media.cachePurgeEnabled &&
    !/^[a-f0-9]{32}$/u.test(candidate.media.cloudflareZoneId)
  )
    throw new Error('Invalid configuration: /media/cloudflareZoneId must be a 32-character ID');

  return deepFreeze(candidate) as AppConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotEnv({ quiet: true });
  return parseConfig(env);
}

/** Resolves an environment-variable reference without copying secret values into config. */
export function resolveSecretReference(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(reference)) throw new Error('Invalid secret reference.');
  const value = env[reference];
  if (value === undefined || value.length === 0) throw new Error('Required secret is unavailable.');
  return value;
}
