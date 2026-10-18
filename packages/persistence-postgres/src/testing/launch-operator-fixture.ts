import { randomUUID } from 'node:crypto';
import type { OperatorAwsCall } from '../admin-totp-operator-host.js';
import type { LaunchOperatorBinding } from '../launch-operator-host.js';

/** Synthetic AWS and TLS-shaped secret only. Native tests inject a local connector. */
export function launchOperatorFixture(
  databaseName = 'nakh',
  databaseUser = 'nakh',
): LaunchOperatorBinding {
  return {
    version: 1,
    environment: 'staging',
    sourceSha: 'a'.repeat(40),
    telegramBotId: '123456789',
    accountId: '123456789012',
    region: 'eu-west-1',
    principalArn: 'arn:aws:sts::123456789012:assumed-role/launch-operator/tester',
    principalUserId: 'AROA12345678901234567:tester',
    operatorId: randomUUID(),
    databaseSecretArn:
      'arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh/staging/operator-Abc123',
    databaseHost: 'reviewed.rds.invalid',
    databaseName,
    databaseUser,
    approvedCommandDigest: null,
  };
}
export function launchOperatorFixtureUrl(binding: LaunchOperatorBinding): string {
  return `postgresql://${binding.databaseUser}:fixture-only@${binding.databaseHost}:5432/${binding.databaseName}?sslmode=verify-full`;
}
export function launchOperatorFixtureAws(binding: LaunchOperatorBinding): OperatorAwsCall {
  return (service, operation, input, region) => {
    if (region !== binding.region) throw new Error('Fixture region mismatch');
    if (service === 'sts' && operation === 'get-caller-identity')
      return Promise.resolve({
        Account: binding.accountId,
        Arn: binding.principalArn,
        UserId: binding.principalUserId,
      });
    if (
      service === 'secretsmanager' &&
      operation === 'get-secret-value' &&
      input.SecretId === binding.databaseSecretArn &&
      input.VersionStage === 'AWSCURRENT'
    )
      return Promise.resolve({
        ARN: binding.databaseSecretArn,
        VersionId: randomUUID(),
        VersionStages: ['AWSCURRENT'],
        SecretString: JSON.stringify({ NAKH_DATABASE_URL: launchOperatorFixtureUrl(binding) }),
      });
    throw new Error('Unexpected fixture AWS call');
  };
}
