import { resolve } from 'node:path';
import { createDatabase, type NakhDatabase } from '../database.js';
import { sourceMigrationDigests } from '../migrations.js';
import { PostgresRuntimeRoleProvisioning } from '../runtime-role-provisioning.js';
import type { RuntimeDatabasePurpose } from '../runtime-database-policy.js';

/** Migration-host command only. Passwords arrive through protected environment
 * injection, never command arguments, Terraform outputs or command receipts. */
async function main(): Promise<void> {
  const [commandId, sourceSha, ...extra] = process.argv.slice(2);
  if (!commandId || !sourceSha || extra.length || process.env.NAKH_RELEASE !== sourceSha)
    throw new Error();
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error();
    return value;
  };
  const url = required('NAKH_DATABASE_URL');
  const urls: Record<RuntimeDatabasePurpose, string> = {
    user: required('NAKH_USER_DATABASE_URL'),
    financial: required('NAKH_FINANCIAL_DATABASE_URL'),
    administration: required('NAKH_ADMIN_DATABASE_URL'),
    maintenance: required('NAKH_MAINTENANCE_DATABASE_URL'),
    scheduler: required('NAKH_SCHEDULER_DATABASE_URL'),
  };
  let database: NakhDatabase | undefined;
  try {
    database = createDatabase({ url, poolMax: 1, statementTimeoutMs: 30000, lockTimeoutMs: 30000 });
    const result = await new PostgresRuntimeRoleProvisioning(database, url).provision({
      commandId,
      sourceSha,
      urls,
      migrations: await sourceMigrationDigests(resolve('migrations')),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await database?.destroy();
  }
}
void main().catch(() => {
  process.stderr.write('Runtime database provisioning unavailable.\n');
  process.exitCode = 1;
});
