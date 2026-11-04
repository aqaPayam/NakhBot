import { describe, expect, it, vi } from 'vitest';
import { launchOperatorCommandDigest } from './launch-operator-host.js';
import {
  captureVpsOperatorBinding,
  captureVpsMfaOperatorBinding,
  runVpsLaunchOperator,
  runVpsMfaOperator,
  vpsMfaCommandDigest,
} from './vps-trusted-operators.js';

const binding = {
  version: 1,
  environment: 'staging',
  sourceSha: 'a'.repeat(40),
  telegramBotId: '123456789',
  machineId: 'b'.repeat(32),
  databaseHost: 'postgres',
  databaseName: 'nakh',
  databaseUser: 'nakh_owner',
  databaseSecretPath: '/run/operator/database.json',
  operatorId: '00000000-0000-4000-8000-000000000009',
  approvedCommandDigest: null,
};
const mfa = {
  ...binding,
  totpSecretPath: '/run/operator/totp.json',
  keyId: 'totp-key-v1',
  keyVersion: 1,
};
const host = { platform: 'linux', uid: 0, machineId: binding.machineId };
const secret = {
  NAKH_DATABASE_URL: 'postgresql://nakh_owner:fixture@postgres/nakh?sslmode=verify-full',
};
const input = {
  requestId: '10000000-0000-4000-8000-000000000001',
  expectedVersion: 0,
  sourceSha: binding.sourceSha,
  environment: 'staging',
  telegramBotId: binding.telegramBotId,
  mode: 'cohort',
  expiresAt: '2099-01-01T00:00:00.000Z',
  reviewDigest: 'c'.repeat(64),
  members: [{ userId: '10000000-0000-4000-8000-000000000002', productEpoch: 0 }],
};
const approval = {
  operation: 'approve',
  input: {
    actorUserId: input.members[0]!.userId,
    requestId: input.requestId,
    roles: ['super_admin'],
    reasonCode: 'bootstrap',
  },
};

describe('private staging VPS operator admission', () => {
  it('captures immutable exact launch and separate MFA custody bindings', () => {
    const candidate = structuredClone(binding),
      captured = captureVpsOperatorBinding(candidate);
    candidate.machineId = 'd'.repeat(32);
    expect(captured.machineId).toBe(binding.machineId);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captureVpsMfaOperatorBinding(mfa))).toBe(true);
    for (const value of [
      { ...binding, environment: 'production' },
      { ...binding, accountId: '123456789012' },
      { ...binding, operatorId: 'owner' },
      { ...binding, approvedCommandDigest: 'main' },
    ])
      expect(() => captureVpsOperatorBinding(value)).toThrow();
    for (const value of [
      { ...mfa, totpSecretPath: binding.databaseSecretPath },
      { ...mfa, totpSecretPath: 'relative.json' },
      { ...mfa, keyId: 'short' },
      { ...mfa, keyVersion: 0 },
      { ...mfa, role: 'super_admin' },
    ])
      expect(() => captureVpsMfaOperatorBinding(value)).toThrow();
  });
  it('denies a plain opening even with its exact protected approval', async () => {
    const request = { operation: 'apply', input },
      read = vi.fn(),
      observe = vi.fn(),
      connect = vi.fn();
    await expect(
      runVpsLaunchOperator(
        { ...binding, approvedCommandDigest: launchOperatorCommandDigest(request) },
        request,
        read,
        observe,
        connect,
      ),
    ).rejects.toThrow('Private VPS operator unavailable.');
    expect(read).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it('denies foreign audiences and cohorts above ten before credential access', async () => {
    const read = vi.fn();
    for (const selected of [
      { ...input, sourceSha: 'd'.repeat(40) },
      { ...input, environment: 'production' },
      { ...input, telegramBotId: '987654321' },
      {
        ...input,
        members: Array.from({ length: 11 }, (_, n) => ({
          userId: `10000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`,
          productEpoch: 0,
        })),
      },
    ])
      await expect(
        runVpsLaunchOperator(binding, { operation: 'receipt', input: selected }, read),
      ).rejects.toThrow('Private VPS operator unavailable.');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects absent, changed or foreign-operator review before reading credentials', async () => {
    const read = vi.fn();
    const request = {
      operation: 'apply-reviewed',
      input,
      review: { dossier: { operatorId: '10000000-0000-4000-8000-000000000009' } },
    };
    for (const selected of [
      binding,
      { ...binding, approvedCommandDigest: launchOperatorCommandDigest(request) },
    ])
      await expect(runVpsLaunchOperator(selected, request, read)).rejects.toThrow(
        'Private VPS operator unavailable.',
      );
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    { ...host, platform: 'win32' },
    { ...host, uid: 10001 },
    { ...host, machineId: 'd'.repeat(32) },
  ])(
    'denies an unqualified machine before credentials for launch and MFA: %j',
    async (identity) => {
      const read = vi.fn(),
        connect = vi.fn(),
        observe = (): Promise<typeof identity> => Promise.resolve(identity);
      await expect(
        runVpsLaunchOperator(binding, { operation: 'health' }, read, observe, connect),
      ).rejects.toThrow();
      await expect(
        runVpsMfaOperator(
          { ...mfa, approvedCommandDigest: vpsMfaCommandDigest(approval) },
          approval,
          read,
          observe,
          connect,
        ),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it('captures machine selection and denies drift after database secret access', async () => {
    const original = structuredClone(binding),
      connect = vi.fn();
    const observe = vi
      .fn()
      .mockResolvedValueOnce(host)
      .mockResolvedValueOnce({ ...host, machineId: 'd'.repeat(32) });
    await expect(
      runVpsLaunchOperator(
        original,
        { operation: 'health' },
        (path) => {
          expect(path).toBe(binding.databaseSecretPath);
          original.machineId = 'd'.repeat(32);
          return Promise.resolve(secret);
        },
        observe,
        connect,
      ),
    ).rejects.toThrow('Private VPS operator unavailable.');
    expect(connect).not.toHaveBeenCalled();
  });
  it('binds MFA approval to canonical command fields while preserving role intent', () => {
    expect(vpsMfaCommandDigest(approval)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      vpsMfaCommandDigest({
        input: {
          roles: ['super_admin'],
          reasonCode: 'bootstrap',
          requestId: input.requestId,
          actorUserId: input.members[0]!.userId,
        },
        operation: 'approve',
      }),
    ).toBe(vpsMfaCommandDigest(approval));
    expect(
      vpsMfaCommandDigest({ ...approval, input: { ...approval.input, roles: ['support'] } }),
    ).not.toBe(vpsMfaCommandDigest(approval));
    expect(() =>
      vpsMfaCommandDigest({ ...approval, input: { ...approval.input, roles: ['root'] } }),
    ).toThrow();
  });
  it('does not read either MFA credential file without exact enrollment approval', async () => {
    const read = vi.fn(),
      observe = vi.fn(),
      connect = vi.fn();
    await expect(runVpsMfaOperator(mfa, approval, read, observe, connect)).rejects.toThrow();
    await expect(
      runVpsMfaOperator(
        { ...mfa, approvedCommandDigest: 'd'.repeat(64) },
        approval,
        read,
        observe,
        connect,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
