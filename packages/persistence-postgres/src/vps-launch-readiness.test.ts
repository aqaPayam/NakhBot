import { describe, expect, it, vi } from 'vitest';
import { captureVpsReadinessBinding, readVpsLaunchReadiness } from './vps-launch-readiness.js';

const binding = {
  version: 1,
  environment: 'staging',
  sourceSha: 'a'.repeat(40),
  telegramBotId: '123456789',
  machineId: 'b'.repeat(32),
  databaseHost: 'postgres',
  databaseName: 'nakh',
  databaseUser: 'nakh_owner',
  databaseSecretPath: '/run/nakh-operator/database.json',
};
const identity = { platform: 'linux', uid: 0, machineId: binding.machineId };
const secret = {
  NAKH_DATABASE_URL:
    'postgresql://nakh_owner:secret@postgres/nakh?sslmode=verify-full&sslrootcert=/run/db-ca.crt',
};

describe('private VPS readiness boundary', () => {
  it('captures a closed staging-only binding and excludes mutation or approval fields', () => {
    const original = structuredClone(binding),
      captured = captureVpsReadinessBinding(original);
    original.machineId = 'c'.repeat(32);
    expect(captured.machineId).toBe(binding.machineId);
    expect(Object.isFrozen(captured)).toBe(true);
    for (const candidate of [
      { ...binding, environment: 'production' },
      { ...binding, operation: 'apply' },
      { ...binding, approvedCommandDigest: 'd'.repeat(64) },
      { ...binding, machineId: '' },
      { ...binding, sourceSha: 'main' },
      { ...binding, databaseSecretPath: 'relative.json' },
      { ...binding, databaseUser: 'owner\n' },
      { ...binding, databaseHost: 'postgres?sslmode=disable' },
    ])
      expect(() => captureVpsReadinessBinding(candidate)).toThrow(
        'Private VPS readiness unavailable.',
      );
  });
  it.each([
    { ...identity, platform: 'win32' },
    { ...identity, uid: 10001 },
    { ...identity, machineId: 'c'.repeat(32) },
  ])('denies an unqualified host before reading credentials: %j', async (host) => {
    const readSecret = vi.fn(),
      connect = vi.fn();
    await expect(
      readVpsLaunchReadiness(binding, readSecret, () => Promise.resolve(host), connect),
    ).rejects.toThrow('Private VPS readiness unavailable.');
    expect(readSecret).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it('captures the selected host before secret access and rejects host drift before database access', async () => {
    const input = structuredClone(binding),
      observe = vi
        .fn()
        .mockResolvedValueOnce(identity)
        .mockResolvedValueOnce({ ...identity, machineId: 'c'.repeat(32) });
    const connect = vi.fn();
    await expect(
      readVpsLaunchReadiness(
        input,
        (path) => {
          expect(path).toBe(binding.databaseSecretPath);
          input.machineId = 'c'.repeat(32);
          return Promise.resolve(secret);
        },
        observe,
        connect,
      ),
    ).rejects.toThrow('Private VPS readiness unavailable.');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    { ...secret, additional: 'not allowed' },
    { NAKH_DATABASE_URL: secret.NAKH_DATABASE_URL.replace('verify-full', 'require') },
    { NAKH_DATABASE_URL: secret.NAKH_DATABASE_URL.replace('@postgres/', '@other/') },
    { NAKH_DATABASE_URL: secret.NAKH_DATABASE_URL + '&options=-c%20role=owner' },
  ])(
    'rejects secret shape, TLS downgrade and endpoint overrides before connecting',
    async (value) => {
      const connect = vi.fn();
      await expect(
        readVpsLaunchReadiness(
          binding,
          () => Promise.resolve(value),
          () => Promise.resolve(identity),
          connect,
        ),
      ).rejects.toThrow('Private VPS readiness unavailable.');
      expect(connect).not.toHaveBeenCalled();
    },
  );
});
