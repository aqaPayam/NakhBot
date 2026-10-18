export type ReleaseEnvironment = 'staging' | 'production';
export function releaseEnvironment(value: unknown): ReleaseEnvironment {
  if (value === undefined || value === 'staging') return 'staging';
  if (value === 'production') return 'production';
  throw new Error('Release environment unavailable.');
}
export function clusterEnvironment(cluster: string): ReleaseEnvironment {
  const match = /^[a-z][a-z0-9-]{1,19}-(staging|production)$/u.exec(cluster);
  if (!match) throw new Error('Release cluster unavailable.');
  return match[1] as ReleaseEnvironment;
}
/** Production is selected explicitly; a typo must never fall back to staging. */
export function releaseTarget(env: Readonly<Record<string, string | undefined>>): Readonly<{
  environment: ReleaseEnvironment;
  terraformDirectory: string;
  imageScope: Readonly<{ environment?: 'production' }>;
}> {
  const environment = releaseEnvironment(env.RELEASE_ENVIRONMENT);
  if (
    environment === 'production' &&
    (!/^[0-9]{12}$/u.test(env.RELEASE_AWS_ACCOUNT_ID ?? '') ||
      env.TF_VAR_expected_aws_account_id !== env.RELEASE_AWS_ACCOUNT_ID ||
      !/^[0-9]{12}$/u.test(env.TF_VAR_staging_aws_account_id ?? '') ||
      env.TF_VAR_staging_aws_account_id === env.RELEASE_AWS_ACCOUNT_ID ||
      env.TF_VAR_database_role_isolation_enabled !== 'true' ||
      env.RELEASE_ARCHIVE_REQUIRED !== 'true')
  )
    throw new Error('Production release prerequisites unavailable.');
  return {
    environment,
    terraformDirectory: 'deploy/terraform/' + environment,
    imageScope: environment === 'production' ? { environment: 'production' } : {},
  };
}
