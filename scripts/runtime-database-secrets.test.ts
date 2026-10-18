import { describe, expect, it } from 'vitest';
import { RELEASE_SERVICES } from './release-images.js';
import {
  DATABASE_PURPOSE_FIELDS,
  databaseRoleIsolationInput,
  databaseSecretFields,
  verifyDatabaseSecretBindings,
} from './runtime-database-secrets.js';

const arn = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh-staging/runtime-AbCd12';
function bindings(service: Parameters<typeof databaseSecretFields>[0]): {
  environment: Record<string, unknown>[];
  secrets: Record<string, unknown>[];
} {
  return {
    environment: [{ name: 'NAKH_DATABASE_ROLE_ISOLATION_ENABLED', value: 'true' }],
    secrets: Object.entries(databaseSecretFields(service, true)).map(([name, field]) => ({
      name,
      valueFrom: `${arn}:${field}::`,
    })),
  };
}
describe('fixed ECS database purpose references', () => {
  it.each([...RELEASE_SERVICES, 'migration'] as const)(
    'admits only the assigned %s references',
    (service) => {
      const data = bindings(service);
      expect(verifyDatabaseSecretBindings(service, true, arn, data.environment, data.secrets)).toBe(
        true,
      );
      if (service === 'migration')
        expect(data.secrets.map((entry) => entry.name).sort()).toEqual(
          ['NAKH_DATABASE_URL', ...DATABASE_PURPOSE_FIELDS].sort(),
        );
      else
        expect(data.secrets.find((entry) => entry.name === 'NAKH_DATABASE_URL')!.valueFrom).toBe(
          `${arn}:${service === 'scheduler' ? 'NAKH_SCHEDULER_DATABASE_URL' : 'NAKH_USER_DATABASE_URL'}::`,
        );
      const expectedNames = {
        api: ['NAKH_DATABASE_URL', 'NAKH_ADMIN_DATABASE_URL'],
        'telegram-gateway': [
          'NAKH_DATABASE_URL',
          'NAKH_ADMIN_DATABASE_URL',
          'NAKH_FINANCIAL_DATABASE_URL',
        ],
        worker: [
          'NAKH_DATABASE_URL',
          'NAKH_FINANCIAL_DATABASE_URL',
          'NAKH_MAINTENANCE_DATABASE_URL',
        ],
        scheduler: ['NAKH_DATABASE_URL', 'NAKH_FINANCIAL_DATABASE_URL'],
        migration: ['NAKH_DATABASE_URL', ...DATABASE_PURPOSE_FIELDS],
      };
      expect(data.secrets.map((entry) => entry.name).sort()).toEqual(
        [...expectedNames[service]].sort(),
      );
    },
  );
  it.each([
    'owner',
    'other-purpose',
    'other-secret',
    'missing',
    'duplicate',
    'plaintext',
    'flag',
    'flag-secret',
    'unknown',
  ] as const)('rejects %s substitution', (kind) => {
    const data = bindings('api');
    if (kind === 'owner') data.secrets[0]!.valueFrom = `${arn}:NAKH_DATABASE_URL::`;
    if (kind === 'other-purpose')
      data.secrets.push({
        name: 'NAKH_FINANCIAL_DATABASE_URL',
        valueFrom: `${arn}:NAKH_FINANCIAL_DATABASE_URL::`,
      });
    if (kind === 'other-secret')
      data.secrets[0]!.valueFrom = `${arn}-other:NAKH_USER_DATABASE_URL::`;
    if (kind === 'missing') data.secrets.pop();
    if (kind === 'duplicate') data.secrets.push(data.secrets[0]!);
    if (kind === 'plaintext')
      data.environment.push({
        name: 'NAKH_ADMIN_DATABASE_URL',
        value: 'private-url-must-not-be-accepted',
      });
    if (kind === 'flag') data.environment[0]!.value = 'false';
    if (kind === 'flag-secret')
      data.secrets.push({ name: 'NAKH_DATABASE_ROLE_ISOLATION_ENABLED', valueFrom: arn });
    if (kind === 'unknown')
      data.secrets.push({ name: 'NAKH_BORROWED_DATABASE_URL', valueFrom: arn });
    expect(verifyDatabaseSecretBindings('api', true, arn, data.environment, data.secrets)).toBe(
      false,
    );
  });
  it('preserves old inactive definitions and rejects hidden purpose injection when disabled', () => {
    const secrets = [{ name: 'NAKH_DATABASE_URL', valueFrom: `${arn}:NAKH_DATABASE_URL::` }];
    expect(verifyDatabaseSecretBindings('api', false, arn, [], secrets)).toBe(true);
    expect(
      verifyDatabaseSecretBindings(
        'api',
        false,
        arn,
        [{ name: 'NAKH_DATABASE_ROLE_ISOLATION_ENABLED', value: 'false' }],
        secrets,
      ),
    ).toBe(true);
    expect(
      verifyDatabaseSecretBindings(
        'api',
        false,
        arn,
        [],
        [...secrets, { name: 'NAKH_ADMIN_DATABASE_URL', valueFrom: arn }],
      ),
    ).toBe(false);
  });
  it('captures the desired flag before targeted apply and requires observed convergence afterwards', () => {
    expect(databaseRoleIsolationInput(undefined, undefined, false)).toBe(false);
    expect(databaseRoleIsolationInput('true', false, true)).toBe(true);
    expect(databaseRoleIsolationInput('true', true, false)).toBe(true);
    expect(() => databaseRoleIsolationInput('true', false, false)).toThrow();
    expect(() => databaseRoleIsolationInput('true', undefined, false)).toThrow();
    expect(() => databaseRoleIsolationInput('yes', true, true)).toThrow();
    expect(() => databaseRoleIsolationInput('true', 'true', true)).toThrow();
  });
});
