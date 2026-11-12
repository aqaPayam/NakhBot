import { config as loadDotEnv } from 'dotenv';
import { Ajv2020 as Ajv, type ErrorObject } from 'ajv/dist/2020.js';
import { Type, type Static } from '@sinclair/typebox';
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

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
      roleIsolationEnabled: Type.Optional(Type.Boolean()),
      financialUrlRef: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' })),
      administrationUrlRef: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' })),
      maintenanceUrlRef: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' })),
    }),
    redis: Type.Object({
      url: Type.String({ minLength: 1 }),
      queuePrefix: Type.String({ minLength: 1, maxLength: 80 }),
    }),
    administration: Type.Object({
      enabled: Type.Boolean(),
      mediaEnabled: Type.Boolean(),
      evidenceAccessKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      evidenceSecretKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      publicOrigin: Type.String({ minLength: 1, maxLength: 253 }),
      totpKeyRingRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      actionKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      reviewNoteKeyRingRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      reviewNoteKeyId: Type.String({ pattern: '^[A-Za-z0-9_-]{8,160}$' }),
      reviewNoteKeyVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    }),
    telegram: Type.Object({
      botTokenRef: Type.String({ minLength: 1 }),
      webhookSecret: Type.String({ minLength: 32 }),
      actionTokenKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      likedByDeliveryEnabled: Type.Boolean(),
      nakhEnabled: Type.Boolean(),
      notificationDeliveryEnabled: Type.Boolean(),
      supportAppealEnabled: Type.Boolean(),
      publicSupportUsername: Type.String({ pattern: '^(?:|[A-Za-z][A-Za-z0-9_]{4,31})$' }),
      accountMenuEnabled: Type.Boolean(),
      freeTestTopupsEnabled: Type.Boolean(),
      startDeliveryEnabled: Type.Boolean(),
      signupEnabled: Type.Boolean(),
      guestPreviewEnabled: Type.Boolean(),
      exploreEnabled: Type.Boolean(),
      starsEnabled: Type.Boolean(),
      starsInvoiceCreationEnabled: Type.Boolean(),
      starsPurchaseApprovalDigest: Type.String({ pattern: '^(?:|[a-f0-9]{64})$' }),
      starsRefundsEnabled: Type.Boolean(),
      starsKeyRingRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      reportsEnabled: Type.Boolean(),
      chatEnabled: Type.Boolean(),
      reportSnapshotKeyId: Type.String({ pattern: '^[A-Za-z0-9_-]{8,160}$' }),
      reportSnapshotKeyVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
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
    deletion: Type.Object({
      workerEnabled: Type.Boolean(),
      apiEnabled: Type.Boolean(),
      returnApiEnabled: Type.Boolean(),
      returnTelegramEnabled: Type.Boolean(),
      freshEntryTelegramEnabled: Type.Boolean(),
      telegramEnabled: Type.Boolean(),
      controlKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      confirmationKeyId: Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' }),
      confirmationKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      cutoverEvidenceHash: Type.String({ pattern: '^(?:|[0-9a-f]{64})$' }),
      evidenceKeyRingRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      accessKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
      secretKeyRef: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,127}$' }),
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
      roleIsolationEnabled: boolean(env.NAKH_DATABASE_ROLE_ISOLATION_ENABLED, false),
      financialUrlRef: required(
        env,
        'NAKH_FINANCIAL_DATABASE_URL_REF',
        'NAKH_FINANCIAL_DATABASE_URL',
      ),
      administrationUrlRef: required(env, 'NAKH_ADMIN_DATABASE_URL_REF', 'NAKH_ADMIN_DATABASE_URL'),
      maintenanceUrlRef: required(
        env,
        'NAKH_MAINTENANCE_DATABASE_URL_REF',
        'NAKH_MAINTENANCE_DATABASE_URL',
      ),
    },
    redis: {
      url: required(env, 'NAKH_REDIS_URL'),
      queuePrefix: required(env, 'NAKH_QUEUE_PREFIX', 'nakh-local'),
    },
    administration: {
      enabled: boolean(env.NAKH_ADMINISTRATION_ENABLED, false),
      mediaEnabled: boolean(env.NAKH_ADMIN_MEDIA_ENABLED, false),
      evidenceAccessKeyRef: required(
        env,
        'NAKH_ADMIN_EVIDENCE_R2_ACCESS_KEY_REF',
        'NAKH_ADMIN_EVIDENCE_R2_ACCESS_KEY',
      ),
      evidenceSecretKeyRef: required(
        env,
        'NAKH_ADMIN_EVIDENCE_R2_SECRET_KEY_REF',
        'NAKH_ADMIN_EVIDENCE_R2_SECRET_KEY',
      ),
      publicOrigin: required(env, 'NAKH_ADMIN_PUBLIC_ORIGIN', 'https://admin.invalid'),
      totpKeyRingRef: required(env, 'NAKH_ADMIN_TOTP_KEY_RING_REF', 'NAKH_ADMIN_TOTP_KEYS'),
      actionKeyRef: required(env, 'NAKH_ADMIN_ACTION_KEY_REF', 'NAKH_ADMIN_ACTION_KEY'),
      reviewNoteKeyRingRef: required(
        env,
        'NAKH_ADMIN_REVIEW_NOTE_KEY_RING_REF',
        'NAKH_ADMIN_REVIEW_NOTE_KEYS',
      ),
      reviewNoteKeyId: required(env, 'NAKH_ADMIN_REVIEW_NOTE_KEY_ID', 'review-notes-v1'),
      reviewNoteKeyVersion: integer(env.NAKH_ADMIN_REVIEW_NOTE_KEY_VERSION, 1),
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
      nakhEnabled: boolean(env.NAKH_TELEGRAM_NAKH_ENABLED, false),
      notificationDeliveryEnabled: boolean(env.NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED, false),
      supportAppealEnabled: boolean(env.NAKH_TELEGRAM_SUPPORT_APPEAL_ENABLED, false),
      publicSupportUsername: env.NAKH_PUBLIC_SUPPORT_TELEGRAM_USERNAME ?? '',
      accountMenuEnabled: boolean(env.NAKH_TELEGRAM_ACCOUNT_MENU_ENABLED, false),
      freeTestTopupsEnabled: boolean(env.NAKH_FREE_TEST_TOPUPS_ENABLED, false),
      startDeliveryEnabled: boolean(env.NAKH_TELEGRAM_START_DELIVERY_ENABLED, false),
      signupEnabled: boolean(env.NAKH_TELEGRAM_SIGNUP_ENABLED, false),
      guestPreviewEnabled: boolean(env.NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED, false),
      exploreEnabled: boolean(env.NAKH_TELEGRAM_EXPLORE_ENABLED, false),
      starsEnabled: boolean(env.NAKH_TELEGRAM_STARS_ENABLED, false),
      starsInvoiceCreationEnabled: boolean(env.NAKH_TELEGRAM_STARS_INVOICES_ENABLED, false),
      starsPurchaseApprovalDigest: env.NAKH_STARS_PURCHASE_APPROVAL_DIGEST ?? '',
      starsRefundsEnabled: boolean(env.NAKH_TELEGRAM_STARS_REFUNDS_ENABLED, false),
      starsKeyRingRef: required(env, 'NAKH_STARS_KEY_RING_REF', 'NAKH_STARS_KEY_RING'),
      reportsEnabled: boolean(env.NAKH_TELEGRAM_REPORTS_ENABLED, false),
      chatEnabled: boolean(env.NAKH_TELEGRAM_CHAT_ENABLED, false),
      reportSnapshotKeyId: required(env, 'NAKH_REPORT_SNAPSHOT_KEY_ID', 'report-snapshot-v1'),
      reportSnapshotKeyVersion: integer(env.NAKH_REPORT_SNAPSHOT_KEY_VERSION, 1),
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
    deletion: {
      workerEnabled: boolean(env.NAKH_DELETION_WORKER_ENABLED, false),
      apiEnabled: boolean(env.NAKH_DELETION_API_ENABLED, false),
      returnApiEnabled: boolean(env.NAKH_RETURN_API_ENABLED, false),
      returnTelegramEnabled: boolean(env.NAKH_RETURN_TELEGRAM_ENABLED, false),
      freshEntryTelegramEnabled: boolean(env.NAKH_FRESH_ENTRY_TELEGRAM_ENABLED, false),
      telegramEnabled: boolean(env.NAKH_DELETION_TELEGRAM_ENABLED, false),
      controlKeyRef: required(env, 'NAKH_ACCOUNT_CONTROL_KEY_REF', 'NAKH_ACCOUNT_CONTROL_KEY'),
      confirmationKeyId: required(env, 'NAKH_DELETION_CONFIRMATION_KEY_ID', 'delete-v1'),
      confirmationKeyRef: required(
        env,
        'NAKH_DELETION_CONFIRMATION_KEY_REF',
        'NAKH_DELETION_CONFIRMATION_KEY',
      ),
      cutoverEvidenceHash: env.NAKH_DELETION_CUTOVER_EVIDENCE_HASH ?? '',
      evidenceKeyRingRef: required(
        env,
        'NAKH_DELETION_EVIDENCE_KEY_RING_REF',
        'NAKH_DELETION_EVIDENCE_KEYS',
      ),
      accessKeyRef: required(env, 'NAKH_DELETION_R2_ACCESS_KEY_REF', 'NAKH_DELETION_R2_ACCESS_KEY'),
      secretKeyRef: required(env, 'NAKH_DELETION_R2_SECRET_KEY_REF', 'NAKH_DELETION_R2_SECRET_KEY'),
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
  {
    try {
      const origin = new URL(candidate.administration.publicOrigin);
      const local =
        ['local', 'test'].includes(candidate.environment) &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
      if (
        origin.origin !== candidate.administration.publicOrigin ||
        origin.username !== '' ||
        origin.password !== '' ||
        (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))
      )
        throw new Error();
    } catch {
      throw new Error(
        'Invalid configuration: administrator origin must be a canonical HTTPS origin.',
      );
    }
  }
  if (
    candidate.administration.mediaEnabled &&
    (!candidate.administration.enabled || !candidate.media.cachePurgeEnabled)
  )
    throw new Error(
      'Invalid configuration: administrator media requires administration and cache purge.',
    );
  if (
    candidate.deletion.workerEnabled &&
    (!candidate.media.cachePurgeEnabled ||
      !/^[0-9a-f]{64}$/u.test(candidate.deletion.cutoverEvidenceHash))
  )
    throw new Error(
      'Invalid configuration: deletion worker requires cache purge and recorded producer-drain evidence.',
    );
  if (candidate.deletion.freshEntryTelegramEnabled && !candidate.deletion.returnTelegramEnabled)
    throw new Error(
      'Invalid configuration: fresh entry Telegram requires configured Return Telegram readiness.',
    );
  if (
    candidate.telegram.signupEnabled &&
    (!candidate.telegram.startDeliveryEnabled || !candidate.media.ingestionEnabled)
  )
    throw new Error(
      'Invalid configuration: signup Telegram requires start delivery and media ingestion.',
    );
  if (candidate.telegram.guestPreviewEnabled && !candidate.telegram.signupEnabled)
    throw new Error('Invalid configuration: Guest Preview requires signup Telegram readiness.');
  if (candidate.telegram.exploreEnabled && !candidate.telegram.signupEnabled)
    throw new Error('Invalid configuration: Explore requires signup Telegram readiness.');
  if (candidate.telegram.nakhEnabled && !candidate.telegram.signupEnabled)
    throw new Error('Invalid configuration: Nakhes require signup Telegram readiness.');
  if (
    candidate.telegram.chatEnabled &&
    !candidate.telegram.signupEnabled &&
    candidate.serviceName !== 'worker'
  )
    throw new Error('Invalid configuration: Chat requires signup Telegram readiness.');
  if (candidate.deletion.returnTelegramEnabled && !candidate.deletion.telegramEnabled)
    throw new Error(
      'Invalid configuration: Return Telegram requires configured deletion Telegram readiness.',
    );
  if (candidate.deletion.returnApiEnabled && !candidate.deletion.apiEnabled)
    throw new Error(
      'Invalid configuration: Return API requires configured deletion API readiness.',
    );
  if (candidate.deletion.telegramEnabled && !candidate.deletion.workerEnabled)
    throw new Error(
      'Invalid configuration: deletion Telegram requires configured deletion worker readiness.',
    );
  if (candidate.deletion.apiEnabled && !candidate.deletion.workerEnabled)
    throw new Error(
      'Invalid configuration: deletion API requires configured deletion worker readiness.',
    );
  if (
    candidate.media.cachePurgeEnabled &&
    !/^[a-f0-9]{32}$/u.test(candidate.media.cloudflareZoneId)
  )
    throw new Error('Invalid configuration: /media/cloudflareZoneId must be a 32-character ID');

  if (candidate.telegram.starsInvoiceCreationEnabled && !candidate.telegram.starsEnabled)
    throw new Error('Invalid configuration: Stars invoice creation requires payment ingress.');
  if (candidate.telegram.accountMenuEnabled && !candidate.telegram.signupEnabled)
    throw new Error('Invalid configuration: account menu requires signup readiness.');
  if (
    candidate.telegram.freeTestTopupsEnabled &&
    (candidate.environment !== 'staging' ||
      !candidate.telegram.accountMenuEnabled ||
      candidate.telegram.starsInvoiceCreationEnabled)
  )
    throw new Error(
      'Invalid configuration: free test top-ups require staging account menus with real invoices disabled.',
    );

  return deepFreeze(candidate) as AppConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotEnv({ quiet: true });
  const input = { ...env };
  // Connection strings and the webhook check need their value in memory, but need not
  // be stored in Docker's inspectable environment. Other secrets remain refs.
  for (const name of ['NAKH_DATABASE_URL', 'NAKH_REDIS_URL', 'NAKH_TELEGRAM_WEBHOOK_SECRET'])
    if (input[name + '_FILE'] !== undefined) input[name] = resolveSecretReference(name, input);
  return parseConfig(input);
}

function readPrivateSecretFile(path: string): string {
  let fd: number | undefined;
  try {
    // Qualified for the Linux service hosts. Environment-only local development
    // remains portable; never pretend Windows mode bits establish a private ACL.
    if (process.platform !== 'linux' || !isAbsolute(path) || normalize(path) !== path)
      throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true }),
      uid = BigInt(process.getuid!());
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.uid !== 0n && before.uid !== uid) ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > 65536n
    )
      throw new Error();
    const bytes = readFileSync(fd),
      after = fstatSync(fd, { bigint: true });
    try {
      if (
        BigInt(bytes.length) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.mode !== before.mode ||
        after.uid !== before.uid ||
        after.nlink !== before.nlink
      )
        throw new Error();
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/u, '');
      if (!value.length || value.includes('\0')) throw new Error();
      return value;
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error('Required secret is unavailable.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Resolve either the existing environment value or one private mounted file.
 * Conflicting sources fail closed; errors never include a path or secret. */
export function resolveSecretReference(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(reference)) throw new Error('Invalid secret reference.');
  const value = env[reference];
  const file = env[reference + '_FILE'];
  if (file !== undefined) {
    if (value !== undefined) throw new Error('Conflicting secret sources.');
    return readPrivateSecretFile(file);
  }
  if (value === undefined || value.length === 0) throw new Error('Required secret is unavailable.');
  return value;
}
