import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  captureOperatorBinding,
  captureOperatorCommand,
  runAdminTotpOperator,
} from './admin-totp-operator-host.js';

const binding = {
  version: 1,
  environment: 'staging',
  accountId: '123456789012',
  region: 'eu-west-1',
  principalArn: 'arn:aws:sts::123456789012:assumed-role/nakh-operator/tester',
  principalUserId: 'AROA12345678901234567:tester',
  operatorId: randomUUID(),
  databaseSecretArn:
    'arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh/staging/operator-database-Abc123',
  totpSecretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh/staging/totp-Abc123',
  keyId: 'operator-test-key',
  keyVersion: 1,
};
const command = {
  operation: 'approve',
  input: {
    actorUserId: randomUUID(),
    requestId: randomUUID(),
    roles: ['support'],
    reasonCode: 'bootstrap',
  },
};
describe('trusted administrator operator boundary', () => {
  it('rechecks the original principal after reading secrets and before connecting to PostgreSQL', async () => {
    const identity = {
      Account: binding.accountId,
      Arn: binding.principalArn,
      UserId: binding.principalUserId,
    };
    const aws = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({
        ARN: binding.databaseSecretArn,
        VersionId: randomUUID(),
        VersionStages: ['AWSCURRENT'],
        SecretString: JSON.stringify({
          NAKH_DATABASE_URL: 'postgres://never-connect.invalid/nakh',
        }),
      })
      .mockResolvedValueOnce({
        ARN: binding.totpSecretArn,
        VersionId: randomUUID(),
        VersionStages: ['AWSCURRENT'],
        SecretString: JSON.stringify([
          { keyId: binding.keyId, keyVersion: 1, key: Buffer.alloc(32, 7).toString('base64url') },
        ]),
      })
      .mockResolvedValueOnce({ ...identity, UserId: 'AROA76543210987654321:tester' });
    await expect(runAdminTotpOperator(binding, command, aws)).rejects.toThrow(
      'Administrator operator unavailable.',
    );
    expect(aws).toHaveBeenCalledTimes(4);
    expect(aws.mock.calls.map((call): unknown => call[0])).toEqual([
      'sts',
      'secretsmanager',
      'secretsmanager',
      'sts',
    ]);
  });
  it('captures immutable configuration and commands without allowing request authority', () => {
    const config = { ...binding },
      request = structuredClone(command);
    const captured = captureOperatorBinding(config),
      selected = captureOperatorCommand(request);
    config.operatorId = randomUUID();
    request.input.roles[0] = 'super_admin';
    expect(captured.operatorId).toBe(binding.operatorId);
    expect(selected.input).toEqual(command.input);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(selected.input)).toBe(true);
    expect(() => captureOperatorCommand({ ...command, operatorId: randomUUID() })).toThrow();
    expect(() =>
      captureOperatorCommand({ ...command, input: { ...command.input, operatorId: randomUUID() } }),
    ).toThrow();
  });
  it('rejects root, user, cross-account/region and ambiguous session bindings', () => {
    for (const change of [
      { principalArn: 'arn:aws:iam::123456789012:root' },
      { principalArn: 'arn:aws:iam::123456789012:user/tester' },
      { accountId: '999999999999' },
      { region: 'us-east-1' },
      { principalUserId: 'AROA12345678901234567:other' },
      { totpSecretArn: binding.databaseSecretArn },
      { keyVersion: 0 },
      { environment: 'test' },
    ])
      expect(() => captureOperatorBinding({ ...binding, ...change })).toThrow();
  });
  it('rejects invalid or duplicated roles and malformed recovery before provider access', async () => {
    const aws = vi.fn();
    for (const input of [
      { ...command.input, roles: ['support', 'support'] },
      { ...command.input, roles: ['owner'] },
      { ...command.input, requestId: 'invalid' },
      { ...command.input, reasonCode: 'anything' },
      { ...command.input, roles: [] },
    ])
      await expect(
        runAdminTotpOperator(binding, { operation: 'approve', input }, aws),
      ).rejects.toThrow('Administrator operator unavailable.');
    expect(() =>
      captureOperatorCommand({
        operation: 'revoke',
        input: { ...command.input, credentialId: randomUUID() },
      }),
    ).toThrow();
    expect(aws).not.toHaveBeenCalled();
  });
  it('requires exact account, session ARN and unique principal ID before any secret read', async () => {
    const identity = {
      Account: binding.accountId,
      Arn: binding.principalArn,
      UserId: binding.principalUserId,
    };
    for (const changed of [
      { Account: '999999999999' },
      { Arn: binding.principalArn + 'x' },
      { UserId: 'AROA76543210987654321:tester' },
    ]) {
      const aws = vi.fn().mockResolvedValue({ ...identity, ...changed });
      await expect(runAdminTotpOperator(binding, command, aws)).rejects.toThrow(
        'Administrator operator unavailable.',
      );
      expect(aws).toHaveBeenCalledTimes(1);
      expect(aws.mock.calls[0]?.[0]).toBe('sts');
    }
  });
  it('rejects substituted, previous-stage or oversized secrets without exposing provider errors', async () => {
    const identity = {
      Account: binding.accountId,
      Arn: binding.principalArn,
      UserId: binding.principalUserId,
    };
    const secret = {
      ARN: binding.databaseSecretArn,
      VersionId: randomUUID(),
      VersionStages: ['AWSCURRENT'],
      SecretString: JSON.stringify({ NAKH_DATABASE_URL: 'postgres://private' }),
    };
    for (const changed of [
      { ARN: binding.totpSecretArn },
      { VersionStages: ['AWSPREVIOUS'] },
      { VersionId: '' },
      { SecretString: 'private'.repeat(10000) },
    ]) {
      const aws = vi
        .fn()
        .mockResolvedValueOnce(identity)
        .mockResolvedValueOnce({ ...secret, ...changed });
      await expect(runAdminTotpOperator(binding, command, aws)).rejects.toThrow(
        'Administrator operator unavailable.',
      );
      expect(aws).toHaveBeenCalledTimes(2);
    }
    const aws = vi.fn().mockRejectedValue(new Error('private-provider-secret'));
    await expect(runAdminTotpOperator(binding, command, aws)).rejects.toThrow(
      /^Administrator operator unavailable\.$/u,
    );
  });
});
