import { describe, expect, it, vi } from 'vitest';
import { runVpsFreeTestCreditControl } from './vps-free-test-credit-control.js';
import { freeTestCreditModeDigest } from './free-test-credit-mode.js';

const binding = {
  version: 1,
  environment: 'staging',
  sourceSha: 'a'.repeat(40),
  telegramBotId: '12345',
  machineId: 'b'.repeat(32),
  databaseHost: 'postgres',
  databaseName: 'nakh',
  databaseUser: 'nakh_owner',
  databaseSecretPath: '/run/operator/database.json',
  operatorId: '10000000-0000-4000-8000-000000000001',
  approvedCommandDigest: null,
};
const input = {
  requestId: '10000000-0000-4000-8000-000000000002',
  expectedVersion: 0,
  enabled: true,
  sourceSha: binding.sourceSha,
  environment: binding.environment,
  telegramBotId: binding.telegramBotId,
  cohortPolicyId: '10000000-0000-4000-8000-000000000003',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const host = { platform: 'linux', uid: 0, machineId: binding.machineId };
describe('protected VPS free-credit control', () => {
  it('requires approval of the exact opening command before reading any database secret', async () => {
    const read = vi.fn(() => Promise.reject(new Error('PRIVATE_DATABASE_SECRET')));
    const observe = vi.fn(() => Promise.resolve(host));
    for (const patch of [
      {},
      { approvedCommandDigest: 'c'.repeat(64) },
      { environment: 'production' },
      { approvedCommandDigest: freeTestCreditModeDigest(input), sourceSha: 'c'.repeat(40) },
    ])
      await expect(
        runVpsFreeTestCreditControl({ ...binding, ...patch }, input, read, observe),
      ).rejects.toThrow('Free test credit control unavailable.');
    expect(read).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
  it('checks the pinned machine and root identity before reading secrets', async () => {
    const read = vi.fn(() => Promise.resolve({}));
    for (const identity of [
      { ...host, uid: 10001 },
      { ...host, platform: 'win32' },
      { ...host, machineId: 'c'.repeat(32) },
    ])
      await expect(
        runVpsFreeTestCreditControl(
          { ...binding, approvedCommandDigest: freeTestCreditModeDigest(input) },
          input,
          read,
          () => Promise.resolve(identity),
        ),
      ).rejects.toThrow('Free test credit control unavailable.');
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps the independent close path available without an opening digest and sanitizes secret failures', async () => {
    const read = vi.fn(() => Promise.reject(new Error('PRIVATE_DATABASE_SECRET')));
    const close = { ...input, enabled: false, cohortPolicyId: null, expiresAt: null };
    await expect(
      runVpsFreeTestCreditControl(binding, close, read, () => Promise.resolve(host)),
    ).rejects.toThrow('Free test credit control unavailable.');
    expect(read).toHaveBeenCalledExactlyOnceWith(binding.databaseSecretPath);
  });
});
