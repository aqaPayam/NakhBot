import type { ReleaseService } from './release-images.js';

export const DATABASE_PURPOSE_FIELDS = [
  'NAKH_USER_DATABASE_URL',
  'NAKH_FINANCIAL_DATABASE_URL',
  'NAKH_ADMIN_DATABASE_URL',
  'NAKH_MAINTENANCE_DATABASE_URL',
  'NAKH_SCHEDULER_DATABASE_URL',
] as const;
const EXTRA_FIELDS: Readonly<Record<ReleaseService, readonly string[]>> = {
  api: ['NAKH_ADMIN_DATABASE_URL'],
  'telegram-gateway': ['NAKH_FINANCIAL_DATABASE_URL', 'NAKH_ADMIN_DATABASE_URL'],
  worker: ['NAKH_FINANCIAL_DATABASE_URL', 'NAKH_MAINTENANCE_DATABASE_URL'],
  scheduler: ['NAKH_FINANCIAL_DATABASE_URL'],
};
export function databaseRoleIsolationInput(
  requested: string | undefined,
  observed: unknown,
  pending: boolean,
): boolean {
  const value = requested ?? 'false';
  if (
    !['true', 'false'].includes(value) ||
    (observed !== undefined && typeof observed !== 'boolean') ||
    (!pending && (observed ?? false) !== (value === 'true'))
  )
    throw new Error('Runtime database configuration unavailable.');
  return value === 'true';
}
export function databaseSecretFields(
  service: ReleaseService | 'migration',
  isolated: boolean,
): Readonly<Record<string, string>> {
  if (!isolated) return { NAKH_DATABASE_URL: 'NAKH_DATABASE_URL' };
  const result: Record<string, string> = {
    NAKH_DATABASE_URL:
      service === 'migration'
        ? 'NAKH_DATABASE_URL'
        : service === 'scheduler'
          ? 'NAKH_SCHEDULER_DATABASE_URL'
          : 'NAKH_USER_DATABASE_URL',
  };
  for (const field of service === 'migration' ? DATABASE_PURPOSE_FIELDS : EXTRA_FIELDS[service])
    result[field] = field;
  return result;
}
/** Inspect ECS references only. No URL/password is read by the release controller. */
export function verifyDatabaseSecretBindings(
  service: ReleaseService | 'migration',
  isolated: boolean,
  secretArn: string,
  environment: readonly Record<string, unknown>[],
  secrets: readonly Record<string, unknown>[],
): boolean {
  const isUrl = (name: unknown): boolean =>
    typeof name === 'string' && /^NAKH_(?:[A-Z_]+_)?DATABASE_URL$/u.test(name);
  const flags = environment.filter(
    (entry) => entry.name === 'NAKH_DATABASE_ROLE_ISOLATION_ENABLED',
  );
  if (
    flags.length > 1 ||
    (isolated
      ? flags.length !== 1 || flags[0]!.value !== 'true'
      : flags.some((entry) => entry.value !== 'false')) ||
    environment.some((entry) => isUrl(entry.name)) ||
    secrets.some((entry) => entry.name === 'NAKH_DATABASE_ROLE_ISOLATION_ENABLED')
  )
    return false;
  const expected = databaseSecretFields(service, isolated),
    urls = secrets.filter((entry) => isUrl(entry.name));
  return (
    urls.length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([name, field]) =>
        urls.filter((entry) => entry.name === name && entry.valueFrom === `${secretArn}:${field}::`)
          .length === 1,
    )
  );
}
