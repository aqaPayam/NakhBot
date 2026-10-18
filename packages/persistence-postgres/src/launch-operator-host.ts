import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { sql } from 'kysely';
import { createDatabase, type DatabaseConfig, type NakhDatabase } from './database.js';
import type { OperatorAwsCall } from './admin-totp-operator-host.js';
import { measureLaunchHealth } from './launch-health-store.js';
import {
  captureLaunchReviewRequest,
  prepareLaunchReview,
  verifyLaunchReviewReference,
  type LaunchReviewRequest,
} from './launch-review.js';
import {
  captureLaunchAudience,
  captureLaunchCohortCommand,
  PostgresLaunchCohortControl,
  type LaunchAudience,
  type LaunchCohortCommand,
} from './launch-cohort-store.js';

function denied(): never {
  throw new Error('Launch operator unavailable.');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    denied();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
export type LaunchOperatorBinding = LaunchAudience &
  Readonly<{
    version: 1;
    accountId: string;
    region: string;
    principalArn: string;
    principalUserId: string;
    operatorId: string;
    databaseSecretArn: string;
    databaseHost: string;
    databaseName: string;
    databaseUser: string;
    approvedCommandDigest: string | null;
  }>;
/** This private, reviewed configuration is authority. Request bodies cannot select it. */
export function captureLaunchOperatorBinding(value: unknown): LaunchOperatorBinding {
  const c = object(structuredClone(value));
  exact(c, [
    'version',
    'environment',
    'sourceSha',
    'telegramBotId',
    'accountId',
    'region',
    'principalArn',
    'principalUserId',
    'operatorId',
    'databaseSecretArn',
    'databaseHost',
    'databaseName',
    'databaseUser',
    'approvedCommandDigest',
  ]);
  captureLaunchAudience({
    sourceSha: c.sourceSha,
    environment: c.environment,
    telegramBotId: c.telegramBotId,
  });
  if (
    c.version !== 1 ||
    typeof c.accountId !== 'string' ||
    !/^[0-9]{12}$/u.test(c.accountId) ||
    typeof c.region !== 'string' ||
    !/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/u.test(c.region) ||
    typeof c.operatorId !== 'string' ||
    !UUID.test(c.operatorId) ||
    typeof c.principalArn !== 'string' ||
    !new RegExp(
      `^arn:aws:sts::${c.accountId}:assumed-role/[A-Za-z0-9_+=,.@-]{1,64}/[A-Za-z0-9_+=,.@-]{2,64}$`,
      'u',
    ).test(c.principalArn) ||
    typeof c.principalUserId !== 'string' ||
    !/^AROA[A-Z0-9]{17}:[A-Za-z0-9_+=,.@-]{2,64}$/u.test(c.principalUserId) ||
    c.principalArn.split('/').at(-1) !== c.principalUserId.split(':').at(-1) ||
    typeof c.databaseSecretArn !== 'string' ||
    !new RegExp(
      `^arn:aws:secretsmanager:${c.region}:${c.accountId}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$`,
      'u',
    ).test(c.databaseSecretArn) ||
    typeof c.databaseHost !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(c.databaseHost) ||
    typeof c.databaseName !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(c.databaseName) ||
    typeof c.databaseUser !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(c.databaseUser) ||
    (c.approvedCommandDigest !== null &&
      (typeof c.approvedCommandDigest !== 'string' || !HASH.test(c.approvedCommandDigest)))
  )
    denied();
  return Object.freeze(c) as LaunchOperatorBinding;
}
export type LaunchOperatorRequest =
  | LaunchReviewRequest
  | Readonly<{ operation: 'apply'; input: LaunchCohortCommand }>
  | Readonly<{ operation: 'receipt'; input: LaunchCohortCommand }>
  | Readonly<{ operation: 'apply-reviewed'; input: LaunchCohortCommand; review: unknown }>
  | Readonly<{ operation: 'inspect' | 'health' }>
  | Readonly<{ operation: 'resolve-member'; telegramUserId: string }>;
export function captureLaunchOperatorRequest(value: unknown): LaunchOperatorRequest {
  const c = object(structuredClone(value));
  if (c.operation === 'prepare-review') return captureLaunchReviewRequest(c);
  if (c.operation === 'apply' || c.operation === 'apply-reviewed' || c.operation === 'receipt') {
    exact(
      c,
      c.operation === 'apply-reviewed' ? ['operation', 'input', 'review'] : ['operation', 'input'],
    );
    const input = captureLaunchCohortCommand(c.input);
    input.members.forEach(Object.freeze);
    Object.freeze(input.members);
    if (c.operation === 'apply-reviewed') {
      if (input.mode !== 'cohort') denied();
      return Object.freeze({
        operation: 'apply-reviewed',
        input: Object.freeze(input),
        review: c.review,
      });
    }
    return Object.freeze({ operation: c.operation, input: Object.freeze(input) });
  }
  if (c.operation === 'inspect' || c.operation === 'health') {
    exact(c, ['operation']);
    return Object.freeze({ operation: c.operation });
  }
  exact(c, ['operation', 'telegramUserId']);
  if (
    c.operation !== 'resolve-member' ||
    typeof c.telegramUserId !== 'string' ||
    !/^[1-9][0-9]{0,15}$/u.test(c.telegramUserId) ||
    !Number.isSafeInteger(Number(c.telegramUserId))
  )
    denied();
  return Object.freeze({ operation: 'resolve-member', telegramUserId: c.telegramUserId });
}
/** Canonical command hash is an approval reference, not proof that drills occurred. */
export function launchOperatorCommandDigest(value: unknown): string {
  const request = captureLaunchOperatorRequest(value);
  if (request.operation !== 'apply' && request.operation !== 'apply-reviewed') denied();
  return createHash('sha256').update(JSON.stringify(request.input)).digest('hex');
}
/** Reject libpq query overrides and require verified TLS against the reviewed endpoint. */
export function captureLaunchOperatorDatabaseUrl(
  value: unknown,
  binding: LaunchOperatorBinding,
): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16384) denied();
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== binding.databaseHost ||
    (url.port !== '' && url.port !== '5432') ||
    url.hash !== '' ||
    decodeURIComponent(url.username) !== binding.databaseUser ||
    url.password.length === 0 ||
    decodeURIComponent(url.pathname) !== '/' + binding.databaseName ||
    url.searchParams.get('sslmode') !== 'verify-full'
  )
    denied();
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['sslmode', 'sslrootcert'].includes(key))
  )
    denied();
  const certificate = url.searchParams.get('sslrootcert');
  if (certificate !== null && (!isAbsolute(certificate) || /[\r\n\0]/u.test(certificate))) denied();
  return value;
}
/** CLI supplies real AWS and the default TLS connection. Injected connectors are
 * explicit test seams; synthetic AWS/local native fixtures are not provider acceptance. */
export async function runLaunchOperator(
  binding: unknown,
  command: unknown,
  aws: OperatorAwsCall,
  connect: (config: DatabaseConfig) => NakhDatabase = createDatabase,
): Promise<unknown> {
  let database: NakhDatabase | undefined;
  try {
    const c = captureLaunchOperatorBinding(binding),
      request = captureLaunchOperatorRequest(command);
    if (
      request.operation === 'receipt' &&
      (request.input.sourceSha !== c.sourceSha ||
        request.input.environment !== c.environment ||
        request.input.telegramBotId !== c.telegramBotId)
    )
      denied();
    if (
      request.operation === 'prepare-review' &&
      (request.intent.sourceSha !== c.sourceSha ||
        request.intent.environment !== c.environment ||
        request.intent.telegramBotId !== c.telegramBotId)
    )
      denied();
    if (request.operation === 'apply-reviewed')
      verifyLaunchReviewReference(request.review, request.input, new Date());
    if (request.operation === 'apply' || request.operation === 'apply-reviewed') {
      const input = request.input;
      if (
        input.sourceSha !== c.sourceSha ||
        input.environment !== c.environment ||
        input.telegramBotId !== c.telegramBotId ||
        (input.mode === 'cohort' &&
          launchOperatorCommandDigest(request) !== c.approvedCommandDigest)
      )
        denied();
    }
    const authenticate = async (): Promise<void> => {
      const identity = object(await aws('sts', 'get-caller-identity', {}, c.region));
      if (
        identity.Account !== c.accountId ||
        identity.Arn !== c.principalArn ||
        identity.UserId !== c.principalUserId
      )
        denied();
    };
    await authenticate();
    const secret = object(
      await aws(
        'secretsmanager',
        'get-secret-value',
        { SecretId: c.databaseSecretArn, VersionStage: 'AWSCURRENT' },
        c.region,
      ),
    );
    if (
      secret.ARN !== c.databaseSecretArn ||
      !Array.isArray(secret.VersionStages) ||
      !secret.VersionStages.includes('AWSCURRENT') ||
      typeof secret.VersionId !== 'string' ||
      !/^[A-Za-z0-9-]{32,64}$/u.test(secret.VersionId) ||
      typeof secret.SecretString !== 'string' ||
      Buffer.byteLength(secret.SecretString) > 65536
    )
      denied();
    const contents = object(JSON.parse(secret.SecretString) as unknown);
    exact(contents, ['NAKH_DATABASE_URL']);
    const url = captureLaunchOperatorDatabaseUrl(contents.NAKH_DATABASE_URL, c);
    await authenticate();
    database = connect({ url, poolMax: 1, statementTimeoutMs: 15000, lockTimeoutMs: 10000 });
    const identity = (
      await sql<{
        database: string;
        login: string;
        current: string;
        owner: string;
        migrated: boolean;
      }>`SELECT
      current_database() AS database,session_user::text AS login,current_user::text AS current,
      pg_get_userbyid(relowner) AS owner,EXISTS(SELECT 1 FROM platform.schema_migrations
        WHERE name='000163_m9_launch_cohort_authority.sql') AS migrated
      FROM pg_class WHERE oid='platform.audit_logs'::regclass`.execute(database)
    ).rows[0];
    if (
      !identity ||
      !identity.migrated ||
      identity.database !== c.databaseName ||
      identity.login !== c.databaseUser ||
      identity.current !== c.databaseUser ||
      identity.owner !== c.databaseUser
    )
      denied();
    await authenticate();
    if (request.operation === 'receipt')
      return await new PostgresLaunchCohortControl(database, { operatorId: c.operatorId }).receipt(
        request.input,
      );
    if (request.operation === 'health' || request.operation === 'prepare-review') {
      const health = await measureLaunchHealth(database, {
        sourceSha: c.sourceSha,
        environment: c.environment,
        telegramBotId: c.telegramBotId,
      });
      return request.operation === 'health'
        ? health
        : prepareLaunchReview(health, request, c.operatorId);
    }
    if (request.operation === 'apply' || request.operation === 'apply-reviewed') {
      let deadline: string | undefined;
      if (request.operation === 'apply-reviewed') {
        verifyLaunchReviewReference(request.review, request.input, new Date());
        deadline = String(object(object(request.review).dossier).expiresAt);
      }
      return await new PostgresLaunchCohortControl(database, { operatorId: c.operatorId }).apply(
        request.input,
        deadline,
      );
    }
    if (request.operation === 'resolve-member') {
      const member = await database
        .selectFrom('identity.telegram_identities as telegram')
        .innerJoin('identity.accounts as account', 'account.user_id', 'telegram.user_id')
        .select(['account.user_id as userId', 'account.product_epoch as productEpoch'])
        .where('telegram.telegram_user_id', '=', request.telegramUserId)
        .where('account.state', '!=', 'deleted')
        .executeTakeFirst();
      return member ?? null;
    }
    const policy = (
      await sql<{
        policyId: string;
        version: string | null;
        mode: string;
        metadata: Record<string, unknown>;
      }>`SELECT id AS "policyId",
      platform.launch_policy_version(id)::text AS version,result_code AS mode,metadata
      FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'
      ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1`.execute(database)
    ).rows[0];
    if (!policy) return null;
    if (policy.version === null) denied();
    return {
      policyId: policy.policyId,
      version: Number(policy.version),
      mode: policy.mode,
      sourceSha: policy.metadata.sourceSha,
      environment: policy.metadata.environment,
      telegramBotId: policy.metadata.telegramBotId,
      expiresAt: policy.metadata.expiresAt,
      cohortSize: policy.metadata.cohortSize,
      reviewDigest: policy.metadata.reviewDigest,
    };
  } catch {
    return denied();
  } finally {
    try {
      await database?.destroy();
    } catch {
      denied();
    }
  }
}
