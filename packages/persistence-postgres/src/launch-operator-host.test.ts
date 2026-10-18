import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  captureLaunchOperatorBinding,
  captureLaunchOperatorDatabaseUrl,
  captureLaunchOperatorRequest,
  launchOperatorCommandDigest,
  runLaunchOperator,
  type LaunchOperatorBinding,
} from './launch-operator-host.js';
import {
  launchOperatorFixture,
  launchOperatorFixtureAws,
  launchOperatorFixtureUrl,
} from './testing/launch-operator-fixture.js';

const binding = launchOperatorFixture();
const command = {
  operation: 'apply',
  input: {
    requestId: randomUUID(),
    expectedVersion: 0,
    sourceSha: binding.sourceSha,
    environment: binding.environment,
    telegramBotId: binding.telegramBotId,
    mode: 'cohort',
    expiresAt: '2030-01-01T00:00:00.000Z',
    reviewDigest: 'b'.repeat(64),
    members: [{ userId: randomUUID(), productEpoch: 0 }],
  },
};
const approved = (): LaunchOperatorBinding => ({
  ...binding,
  approvedCommandDigest: launchOperatorCommandDigest(command),
});
describe('protected cohort operator host', () => {
  it('captures deep immutable commands and hashes the complete canonical native command', () => {
    const original = structuredClone(command),
      captured = captureLaunchOperatorRequest(original);
    original.input.members[0]!.productEpoch = 9;
    expect(captured).toEqual(command);
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured.operation !== 'apply') throw new Error();
    expect(Object.isFrozen(captured.input.members[0])).toBe(true);
    const digest = launchOperatorCommandDigest(command);
    for (const changed of [
      { requestId: randomUUID() },
      { expectedVersion: 1 },
      { reviewDigest: 'c'.repeat(64) },
      { sourceSha: 'd'.repeat(40) },
      { environment: 'production' },
      { telegramBotId: '987654321' },
      { expiresAt: '2030-01-01T00:00:01.000Z' },
      { members: [{ ...command.input.members[0], productEpoch: 1 }] },
    ])
      expect(
        launchOperatorCommandDigest({
          operation: 'apply',
          input: { ...command.input, ...changed },
        }),
      ).not.toBe(digest);
    const other = { userId: randomUUID(), productEpoch: 0 };
    expect(
      launchOperatorCommandDigest({
        operation: 'apply',
        input: { ...command.input, members: [other, ...command.input.members] },
      }),
    ).toBe(
      launchOperatorCommandDigest({
        operation: 'apply',
        input: { ...command.input, members: [...command.input.members, other] },
      }),
    );
  });
  it('requires exact opening approval and audience before any provider access', async () => {
    const aws = vi.fn(),
      connect = vi.fn();
    for (const change of [
      { approvedCommandDigest: null },
      { approvedCommandDigest: 'f'.repeat(64) },
      { sourceSha: 'e'.repeat(40) },
      { environment: 'production' },
      { telegramBotId: '987654321' },
    ])
      await expect(
        runLaunchOperator({ ...approved(), ...change }, command, aws, connect),
      ).rejects.toThrow('Launch operator unavailable.');
    expect(aws).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects ambiguous configuration and request authority', () => {
    for (const change of [
      { principalArn: 'arn:aws:iam::123456789012:root' },
      { principalUserId: 'AROA12345678901234567:other' },
      { accountId: '999999999999' },
      { region: 'us-east-1' },
      { databaseHost: 'host/?override' },
      { databaseUser: 'nakh;SET ROLE owner' },
      { approvedCommandDigest: '' },
      { extra: true },
    ])
      expect(() => captureLaunchOperatorBinding({ ...binding, ...change })).toThrow();
    for (const input of [
      { operation: 'inspect', operatorId: randomUUID() },
      { ...command, operatorId: randomUUID() },
      { operation: 'resolve-member', telegramUserId: '01' },
      { operation: 'resolve-member', telegramUserId: '9007199254740992' },
    ])
      expect(() => captureLaunchOperatorRequest(input)).toThrow();
  });
  it('requires exact account, session ARN and unique role ID before secret access', async () => {
    for (const change of [
      { Account: '999999999999' },
      { Arn: binding.principalArn + 'x' },
      { UserId: binding.principalUserId + 'x' },
    ]) {
      const aws = vi.fn().mockResolvedValue({
          Account: binding.accountId,
          Arn: binding.principalArn,
          UserId: binding.principalUserId,
          ...change,
        }),
        connect = vi.fn();
      await expect(
        runLaunchOperator(binding, { operation: 'inspect' }, aws, connect),
      ).rejects.toThrow('Launch operator unavailable.');
      expect(aws).toHaveBeenCalledTimes(1);
      expect(connect).not.toHaveBeenCalled();
    }
  });
  it('checks selected secret ARN, version, current stage, shape and TLS before connecting', async () => {
    const provider = launchOperatorFixtureAws(binding),
      identity = await provider('sts', 'get-caller-identity', {}, binding.region);
    const valid = (await provider(
      'secretsmanager',
      'get-secret-value',
      { SecretId: binding.databaseSecretArn, VersionStage: 'AWSCURRENT' },
      binding.region,
    )) as Record<string, unknown>;
    for (const change of [
      { ARN: binding.databaseSecretArn + 'x' },
      { VersionStages: ['AWSPREVIOUS'] },
      { VersionId: 'unversioned' },
      { SecretString: '{}' },
      { SecretString: 'private-invalid-json' },
      {
        SecretString: JSON.stringify({
          NAKH_DATABASE_URL: launchOperatorFixtureUrl(binding),
          other: true,
        }),
      },
      {
        SecretString: JSON.stringify({
          NAKH_DATABASE_URL: 'postgres://private.invalid/nakh?sslmode=disable',
        }),
      },
      { SecretString: 'x'.repeat(65537) },
    ]) {
      const aws = vi
          .fn()
          .mockResolvedValueOnce(identity)
          .mockResolvedValueOnce({ ...valid, ...change }),
        connect = vi.fn();
      await expect(
        runLaunchOperator(binding, { operation: 'inspect' }, aws, connect),
      ).rejects.toThrow('Launch operator unavailable.');
      expect(aws).toHaveBeenCalledTimes(2);
      expect(connect).not.toHaveBeenCalled();
    }
  });
  it('rechecks principal after secret retrieval and sanitizes connection failure', async () => {
    const provider = launchOperatorFixtureAws(binding);
    let calls = 0;
    const aws = vi.fn(async (...args: Parameters<typeof provider>) => {
        calls++;
        return calls === 3
          ? { Account: binding.accountId, Arn: binding.principalArn, UserId: 'changed' }
          : provider(...args);
      }),
      connect = vi.fn(() => {
        throw new Error('private connection marker');
      });
    await expect(
      runLaunchOperator(binding, { operation: 'inspect' }, aws, connect),
    ).rejects.toThrow('Launch operator unavailable.');
    expect(connect).not.toHaveBeenCalled();
    await expect(
      runLaunchOperator(binding, { operation: 'inspect' }, provider, connect),
    ).rejects.toThrow('Launch operator unavailable.');
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('rejects endpoint, login and TLS/libpq overrides but supports an explicit private CA path', () => {
    const url = launchOperatorFixtureUrl(binding);
    expect(
      captureLaunchOperatorDatabaseUrl(
        url + '&sslrootcert=' + encodeURIComponent(process.cwd() + '/fixture-ca.pem'),
        binding,
      ),
    ).toContain('sslrootcert');
    for (const invalid of [
      url.replace('verify-full', 'require'),
      url.replace('5432', '5433'),
      url.replace(binding.databaseHost, 'other.invalid'),
      url.replace(binding.databaseUser + ':', 'other:'),
      url.replace('/nakh?', '/other?'),
      url + '&host=other.invalid',
      url + '&sslmode=disable',
      url + '&uselibpqcompat=true',
      url + '&sslrootcert=relative.pem',
      url + '#fragment',
      url + '&options=-c%20role%3Downer',
      url.replace(':fixture-only@', '@'),
    ])
      expect(() => captureLaunchOperatorDatabaseUrl(invalid, binding)).toThrow();
  });
});
