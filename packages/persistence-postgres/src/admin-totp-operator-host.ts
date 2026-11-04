import { ReportSnapshotKeyRing, verifyAdminTotpSecretCustody } from '@nakh/application';
import { sql } from 'kysely';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresAdminTotpOperator } from './admin-totp-operator-store.js';

export type OperatorAwsCall = (
  service: 'sts' | 'secretsmanager',
  operation: 'get-caller-identity' | 'get-secret-value',
  input: Readonly<Record<string, string>>,
  region: string,
) => Promise<unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function denied(): never {
  throw new Error('Administrator operator unavailable.');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !(name in value)))
    denied();
}
export type OperatorBinding = Readonly<{
  version: 1;
  environment: 'staging' | 'production';
  accountId: string;
  region: string;
  principalArn: string;
  principalUserId: string;
  operatorId: string;
  databaseSecretArn: string;
  totpSecretArn: string;
  keyId: string;
  keyVersion: number;
}>;
/** Protected operator configuration is the trust root, never request input.
 * Exact STS session ARN AND unique principal ID prevent same-name principal replacement.
 * This mapping requires separate operator approval; it grants no public route. */
export function captureOperatorBinding(value: unknown): OperatorBinding {
  const c = record(structuredClone(value));
  exact(c, [
    'version',
    'environment',
    'accountId',
    'region',
    'principalArn',
    'principalUserId',
    'operatorId',
    'databaseSecretArn',
    'totpSecretArn',
    'keyId',
    'keyVersion',
  ]);
  if (
    c.version !== 1 ||
    !['staging', 'production'].includes(String(c.environment)) ||
    typeof c.accountId !== 'string' ||
    !/^[0-9]{12}$/u.test(c.accountId) ||
    typeof c.region !== 'string' ||
    !/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/u.test(c.region) ||
    typeof c.operatorId !== 'string' ||
    !UUID.test(c.operatorId) ||
    typeof c.keyId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,160}$/u.test(c.keyId) ||
    !Number.isSafeInteger(c.keyVersion) ||
    Number(c.keyVersion) < 1 ||
    typeof c.principalArn !== 'string' ||
    !new RegExp(
      `^arn:aws:sts::${c.accountId}:assumed-role/[A-Za-z0-9_+=,.@-]{1,64}/[A-Za-z0-9_+=,.@-]{2,64}$`,
      'u',
    ).test(c.principalArn) ||
    typeof c.principalUserId !== 'string' ||
    !/^AROA[A-Z0-9]{17}:[A-Za-z0-9_+=,.@-]{2,64}$/u.test(c.principalUserId) ||
    c.principalArn.split('/').at(-1) !== c.principalUserId.split(':').at(-1)
  )
    denied();
  for (const field of ['databaseSecretArn', 'totpSecretArn']) {
    if (
      typeof c[field] !== 'string' ||
      !new RegExp(
        `^arn:aws:secretsmanager:${c.region}:${c.accountId}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$`,
        'u',
      ).test(c[field])
    )
      denied();
  }
  if (c.databaseSecretArn === c.totpSecretArn) denied();
  return Object.freeze(c) as OperatorBinding;
}
type Approval = Parameters<PostgresAdminTotpOperator['approve']>[0];
type Revocation = Parameters<PostgresAdminTotpOperator['revokeCredential']>[0];
export type OperatorCommand =
  | Readonly<{ operation: 'approve'; input: Approval }>
  | Readonly<{ operation: 'revoke'; input: Revocation }>;
export function captureOperatorCommand(value: unknown): OperatorCommand {
  const c = record(structuredClone(value));
  exact(c, ['operation', 'input']);
  const input = record(c.input);
  exact(input, [
    'actorUserId',
    'requestId',
    'reasonCode',
    c.operation === 'approve' ? 'roles' : 'credentialId',
  ]);
  if (
    (c.operation !== 'approve' && c.operation !== 'revoke') ||
    typeof input.actorUserId !== 'string' ||
    !UUID.test(input.actorUserId) ||
    typeof input.requestId !== 'string' ||
    !UUID.test(input.requestId) ||
    !['bootstrap', 'enrollment', 'recovery'].includes(String(input.reasonCode))
  )
    denied();
  if (c.operation === 'approve') {
    if (
      !Array.isArray(input.roles) ||
      input.roles.length < 1 ||
      input.roles.length > 3 ||
      new Set(input.roles).size !== input.roles.length ||
      input.roles.some(
        (role: unknown) => !['super_admin', 'moderator', 'support'].includes(String(role)),
      )
    )
      denied();
    Object.freeze(input.roles);
  } else if (typeof input.credentialId !== 'string' || !UUID.test(input.credentialId)) denied();
  Object.freeze(input);
  return Object.freeze(c) as OperatorCommand;
}
export async function checkTotpCustody(
  database: NakhDatabase,
  keys: ReportSnapshotKeyRing,
): Promise<void> {
  const rows = (
    await sql<{
      id: string;
      userId: string;
      keyId: string;
      keyVersion: number;
      ciphertext: Buffer;
      nonce: Buffer;
    }>`SELECT DISTINCT ON (secret.key_id,secret.key_version)
    secret.id,admin.user_id AS "userId",secret.key_id AS "keyId",secret.key_version AS "keyVersion",
    secret.ciphertext,secret.nonce FROM (
      SELECT id,admin_user_id,key_id,key_version,ciphertext,nonce FROM administration.admin_totp_credentials
      UNION ALL SELECT id,admin_user_id,key_id,key_version,ciphertext,nonce FROM administration.admin_totp_enrollments
    ) secret JOIN administration.admin_users admin ON admin.id=secret.admin_user_id
    ORDER BY secret.key_id,secret.key_version,secret.id`.execute(database)
  ).rows;
  // Same bounded per-version custody check as the API, including historical versions.
  for (const row of rows)
    verifyAdminTotpSecretCustody(
      { actorUserId: row.userId, credentialId: row.id },
      {
        keyId: row.keyId,
        keyVersion: row.keyVersion,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
      },
      keys,
    );
}
/** The AWS transport and native connection are explicit test seams; the CLI supplies
 * real AWS CLI and PostgreSQL adapters. Provider fixtures do not establish launch acceptance. */
export async function runAdminTotpOperator(
  binding: unknown,
  command: unknown,
  aws: OperatorAwsCall,
): Promise<
  | Awaited<ReturnType<PostgresAdminTotpOperator['approve']>>
  | Awaited<ReturnType<PostgresAdminTotpOperator['revokeCredential']>>
> {
  let database: NakhDatabase | undefined;
  let operator: PostgresAdminTotpOperator | undefined;
  let writeKey: Uint8Array | undefined;
  try {
    const c = captureOperatorBinding(binding),
      request = captureOperatorCommand(command);
    const authenticate = async (): Promise<void> => {
      const identity = record(await aws('sts', 'get-caller-identity', {}, c.region));
      if (
        identity.Account !== c.accountId ||
        identity.Arn !== c.principalArn ||
        identity.UserId !== c.principalUserId
      )
        denied();
    };
    await authenticate();
    const secret = async (arn: string): Promise<string> => {
      const result = record(
        await aws(
          'secretsmanager',
          'get-secret-value',
          {
            SecretId: arn,
            VersionStage: 'AWSCURRENT',
          },
          c.region,
        ),
      );
      if (
        result.ARN !== arn ||
        !Array.isArray(result.VersionStages) ||
        !result.VersionStages.includes('AWSCURRENT') ||
        typeof result.VersionId !== 'string' ||
        !/^[A-Za-z0-9-]{32,64}$/u.test(result.VersionId) ||
        typeof result.SecretString !== 'string' ||
        Buffer.byteLength(result.SecretString) > 65536
      )
        denied();
      return result.SecretString;
    };
    const databaseSecret = record(JSON.parse(await secret(c.databaseSecretArn)) as unknown);
    exact(databaseSecret, ['NAKH_DATABASE_URL']);
    if (
      typeof databaseSecret.NAKH_DATABASE_URL !== 'string' ||
      !/^postgres(?:ql)?:\/\//u.test(databaseSecret.NAKH_DATABASE_URL)
    )
      denied();
    const keys = new ReportSnapshotKeyRing(await secret(c.totpSecretArn));
    const encryption = keys.writeKey(c.keyId, c.keyVersion);
    writeKey = encryption.key;
    await authenticate();
    database = createDatabase({
      url: databaseSecret.NAKH_DATABASE_URL,
      poolMax: 2,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    const schema = await database
      .selectFrom('platform.schema_migrations')
      .select('name')
      .where('name', '=', '000161_m9_chat_reporting.sql')
      .executeTakeFirst();
    if (schema === undefined) denied();
    await checkTotpCustody(database, keys);
    await authenticate();
    operator = new PostgresAdminTotpOperator(
      database,
      { operatorId: c.operatorId },
      encryption,
      keys,
    );
    return request.operation === 'approve'
      ? await operator.approve(request.input)
      : await operator.revokeCredential(request.input);
  } catch {
    return denied();
  } finally {
    operator?.dispose();
    writeKey?.fill(0);
    await database?.destroy();
  }
}
