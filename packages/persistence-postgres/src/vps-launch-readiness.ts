import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { sql } from 'kysely';
import { createDatabase, type DatabaseConfig, type NakhDatabase } from './database.js';
import { captureLaunchAudience, type LaunchAudience } from './launch-cohort-store.js';
import { captureLaunchOperatorDatabaseUrl } from './launch-operator-host.js';
import { measureLaunchHealth } from './launch-health-store.js';

export type VpsReadinessBinding = LaunchAudience &
  Readonly<{
    version: 1;
    machineId: string;
    databaseHost: string;
    databaseName: string;
    databaseUser: string;
    databaseSecretPath: string;
  }>;
export type VpsMachineIdentity = Readonly<{ platform: string; uid: number; machineId: string }>;
function denied(): never {
  throw new Error('Private VPS readiness unavailable.');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
export const VPS_READINESS_BINDING_FIELDS = [
  'version',
  'environment',
  'sourceSha',
  'telegramBotId',
  'machineId',
  'databaseHost',
  'databaseName',
  'databaseUser',
  'databaseSecretPath',
] as const;
export function captureVpsReadinessBinding(value: unknown): VpsReadinessBinding {
  const c = object(structuredClone(value));
  const keys = VPS_READINESS_BINDING_FIELDS;
  if (Object.keys(c).length !== keys.length || keys.some((key) => !Object.hasOwn(c, key))) denied();
  try {
    captureLaunchAudience({
      environment: c.environment,
      sourceSha: c.sourceSha,
      telegramBotId: c.telegramBotId,
    });
  } catch {
    denied();
  }
  if (
    c.version !== 1 ||
    c.environment !== 'staging' ||
    typeof c.machineId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(c.machineId) ||
    typeof c.databaseHost !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(c.databaseHost) ||
    typeof c.databaseName !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(c.databaseName) ||
    typeof c.databaseUser !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(c.databaseUser) ||
    typeof c.databaseSecretPath !== 'string' ||
    !isAbsolute(c.databaseSecretPath) ||
    /[\r\n\0]/u.test(c.databaseSecretPath)
  )
    denied();
  return Object.freeze(c) as VpsReadinessBinding;
}

export async function observeVpsMachine(): Promise<VpsMachineIdentity> {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    machineId: (await readFile('/etc/machine-id', 'utf8')).trim(),
  };
}

/** Trusted staging host admission shared by private operator CLIs. Injected
 * identity/connection providers are test seams, not deployed-host evidence. */
export async function withVpsOwnerDatabase<T>(
  binding: unknown,
  readSecret: (path: string) => Promise<unknown>,
  operation: (database: NakhDatabase, authenticate: () => Promise<void>) => Promise<T>,
  observe: () => Promise<VpsMachineIdentity> = observeVpsMachine,
  connect: (config: DatabaseConfig) => NakhDatabase = createDatabase,
): Promise<T> {
  let database: NakhDatabase | undefined;
  try {
    const c = captureVpsReadinessBinding(binding);
    const authenticate = async (): Promise<void> => {
      const identity = await observe();
      if (identity.platform !== 'linux' || identity.uid !== 0 || identity.machineId !== c.machineId)
        denied();
    };
    await authenticate();
    const contents = object(await readSecret(c.databaseSecretPath));
    if (Object.keys(contents).length !== 1 || !Object.hasOwn(contents, 'NAKH_DATABASE_URL'))
      denied();
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
      }>`SELECT current_database() AS database,session_user::text AS login,current_user::text AS current,
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
    return await operation(database, authenticate);
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

/** Observation only: no opening, approval or mutation request is accepted. */
export async function readVpsLaunchReadiness(
  binding: unknown,
  readSecret: (path: string) => Promise<unknown>,
  observe: () => Promise<VpsMachineIdentity> = observeVpsMachine,
  connect: (config: DatabaseConfig) => NakhDatabase = createDatabase,
): Promise<unknown> {
  const c = captureVpsReadinessBinding(binding);
  return withVpsOwnerDatabase(
    c,
    readSecret,
    async (database) => ({
      version: 1,
      kind: 'private-vps-readiness',
      launchAuthorized: false,
      productionQualified: false,
      machineId: c.machineId,
      health: await measureLaunchHealth(database, {
        sourceSha: c.sourceSha,
        environment: c.environment,
        telegramBotId: c.telegramBotId,
      }),
    }),
    observe,
    connect,
  );
}
