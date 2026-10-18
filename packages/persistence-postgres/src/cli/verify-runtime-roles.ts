import { verifyRuntimeDatabaseBindings } from '../runtime-database.js';
async function main(): Promise<void> {
  const [sourceSha, ...extra] = process.argv.slice(2);
  const environment = process.env.NAKH_ENV;
  if (
    !sourceSha ||
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    extra.length ||
    process.env.NAKH_RELEASE !== sourceSha ||
    !['staging', 'production'].includes(environment ?? '') ||
    process.env.NAKH_DATABASE_ROLE_ISOLATION_ENABLED !== 'true'
  )
    throw new Error();
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error();
    return value;
  };
  await verifyRuntimeDatabaseBindings({
    baseUrl: required('NAKH_DATABASE_URL'),
    requireTls: environment === 'production',
    urls: {
      user: required('NAKH_USER_DATABASE_URL'),
      financial: required('NAKH_FINANCIAL_DATABASE_URL'),
      administration: required('NAKH_ADMIN_DATABASE_URL'),
      maintenance: required('NAKH_MAINTENANCE_DATABASE_URL'),
      scheduler: required('NAKH_SCHEDULER_DATABASE_URL'),
    },
  });
  process.stdout.write(
    JSON.stringify({ verified: true, sourceSha, roles: 5, readOnly: true }) + '\n',
  );
}
void main().catch(() => {
  process.stderr.write('Runtime database role verification unavailable.\n');
  process.exitCode = 1;
});
