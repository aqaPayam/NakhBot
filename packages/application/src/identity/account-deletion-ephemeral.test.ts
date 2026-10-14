import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AccountDeletionLease } from './account-deletion.js';
import {
  ExecuteAccountDeletionEphemeral,
  type AccountDeletionEphemeralStore,
  type AccountDeletionEphemeralProvider,
  type AccountDeletionSessions,
  type DeletionEphemeralOperation,
} from './account-deletion-ephemeral.js';
const id = '10000000-0000-4000-8000-000000000001';
const lease: AccountDeletionLease = {
  deletionRecordId: id,
  userId: id,
  phase: 'ephemeral_access',
  checkpointVersion: 5,
  leaseOwner: id,
  leaseGeneration: 1,
  leaseExpiresAt: new Date('2030-01-01'),
  attemptCount: 1,
};
const operation: DeletionEphemeralOperation = {
  id,
  deletionRecordId: id,
  userId: id,
  productEpoch: 0,
  namespaceHash: 'a'.repeat(64),
  cutoverEvidenceHash: 'b'.repeat(64),
  stage: 'owned_remove',
  cursor: '0',
};
function scene(): {
  store: AccountDeletionEphemeralStore;
  sessions: AccountDeletionSessions;
  provider: AccountDeletionEphemeralProvider;
  execute: ExecuteAccountDeletionEphemeral;
  mocks: Readonly<
    Record<
      'claimNext' | 'assertCurrent' | 'complete' | 'finish' | 'revokeNext' | 'verify' | 'provide',
      Mock
    >
  >;
} {
  const claimNext = vi.fn<AccountDeletionEphemeralStore['claimNext']>(() =>
    Promise.resolve({ done: false, operation }),
  );
  const assertCurrent = vi.fn<AccountDeletionEphemeralStore['assertCurrent']>(() =>
    Promise.resolve(),
  );
  const complete = vi.fn<AccountDeletionEphemeralStore['complete']>(() => Promise.resolve());
  const finish = vi.fn<AccountDeletionEphemeralStore['finish']>(() =>
    Promise.resolve({ completed: true }),
  );
  const revokeNext = vi.fn<AccountDeletionSessions['revokeNext']>(() =>
    Promise.resolve({ revoked: 0, hasMore: false }),
  );
  const verify = vi.fn<AccountDeletionSessions['verify']>(() =>
    Promise.resolve({ verified: true }),
  );
  const provide = vi.fn<AccountDeletionEphemeralProvider['execute']>(async (_op, guard) => {
    await guard();
    return { cursor: '0', more: false, found: 0 };
  });
  const store: AccountDeletionEphemeralStore = { claimNext, assertCurrent, complete, finish },
    sessions: AccountDeletionSessions = { revokeNext, verify },
    provider: AccountDeletionEphemeralProvider = {
      namespaceHash: operation.namespaceHash,
      execute: provide,
    };
  return {
    store,
    sessions,
    provider,
    execute: new ExecuteAccountDeletionEphemeral(store, sessions, provider),
    mocks: { claimNext, assertCurrent, complete, finish, revokeNext, verify, provide },
  };
}
describe('durable ephemeral deletion coordinator', () => {
  it('finishes native session authority before allocating any provider intent', async () => {
    const f = scene();
    vi.mocked(f.mocks.revokeNext).mockResolvedValue({ revoked: 100, hasMore: true });
    expect(await f.execute.executeNext(lease)).toEqual({ worked: true, completed: false });
    expect(f.mocks.claimNext).not.toHaveBeenCalled();
    expect(f.mocks.provide).not.toHaveBeenCalled();
  });
  it('requires independent native session verification even after a terminal removal batch', async () => {
    const f = scene();
    vi.mocked(f.mocks.verify).mockResolvedValue({ verified: false });
    await expect(f.execute.executeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.mocks.claimNext).not.toHaveBeenCalled();
  });
  it('checks original authority before, within and after the provider operation', async () => {
    const f = scene();
    expect(await f.execute.executeNext(lease)).toEqual({ worked: true, completed: false });
    expect(f.mocks.assertCurrent).toHaveBeenCalledTimes(3);
    expect(f.mocks.complete).toHaveBeenCalledExactlyOnceWith(lease, id, {
      cursor: '0',
      more: false,
      found: 0,
    });
    expect(f.mocks.finish).not.toHaveBeenCalled();
  });
  it('withholds observation and completion when authority expires during a provider wait', async () => {
    const f = scene();
    vi.mocked(f.mocks.assertCurrent)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('expired'));
    await expect(f.execute.executeNext(lease)).rejects.toThrow('expired');
    expect(f.mocks.complete).not.toHaveBeenCalled();
    expect(f.mocks.finish).not.toHaveBeenCalled();
  });
  it('never treats a busy claim or terminal cursor as native completion', async () => {
    const f = scene();
    vi.mocked(f.mocks.claimNext).mockResolvedValueOnce({ done: false });
    expect(await f.execute.executeNext(lease)).toEqual({ worked: false, completed: false });
    expect(f.mocks.finish).not.toHaveBeenCalled();
    vi.mocked(f.mocks.claimNext).mockResolvedValueOnce({ done: true });
    expect(await f.execute.executeNext(lease)).toEqual({ worked: false, completed: true });
    expect(f.mocks.finish).toHaveBeenCalledExactlyOnceWith(lease);
  });
  it('rejects a foreign provider namespace before any provider call', async () => {
    const f = scene();
    vi.mocked(f.mocks.claimNext).mockResolvedValue({
      done: false,
      operation: { ...operation, namespaceHash: 'c'.repeat(64) },
    });
    await expect(f.execute.executeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.mocks.provide).not.toHaveBeenCalled();
  });
  it('retains the originally captured life and cursor across an asynchronous authority wait', async () => {
    const f = scene(),
      issued = { ...operation },
      input = { ...lease };
    f.mocks.claimNext.mockResolvedValue({ done: false, operation: issued });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.mocks.assertCurrent.mockImplementationOnce(() => gate);
    const pending = f.execute.executeNext(input);
    await vi.waitFor(() => {
      expect(f.mocks.assertCurrent).toHaveBeenCalledTimes(1);
    });
    issued.userId = '20000000-0000-4000-8000-000000000002';
    issued.namespaceHash = 'c'.repeat(64);
    input.userId = issued.userId;
    release();
    await pending;
    const captured = f.mocks.provide.mock.calls[0]![0] as DeletionEphemeralOperation;
    expect(captured.userId).toBe(operation.userId);
    expect(captured.namespaceHash).toBe(operation.namespaceHash);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(f.mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ userId: lease.userId }),
      operation.id,
      { cursor: '0', more: false, found: 0 },
    );
  });
  it('executes the same fenced coordinator at final verification checkpoint seven', async () => {
    const f = scene(),
      finalLease = { ...lease, phase: 'verification' as const, checkpointVersion: 7 };
    expect(await f.execute.executeNext(finalLease)).toEqual({ worked: true, completed: false });
    expect(f.mocks.revokeNext).toHaveBeenCalledExactlyOnceWith(finalLease);
    expect(f.mocks.complete).toHaveBeenCalledWith(finalLease, id, {
      cursor: '0',
      more: false,
      found: 0,
    });
    f.mocks.claimNext.mockResolvedValue({ done: true });
    expect(await f.execute.executeNext(finalLease)).toEqual({ worked: false, completed: true });
    expect(f.mocks.finish).toHaveBeenCalledWith(finalLease);
  });
  it.each([
    ['verification', 5],
    ['ephemeral_access', 7],
    ['completed', 8],
  ] as const)('rejects mismatched phase %s checkpoint %i', async (phase, checkpointVersion) => {
    const f = scene();
    await expect(
      f.execute.executeNext({ ...lease, phase, checkpointVersion }),
    ).rejects.toBeDefined();
    expect(f.mocks.claimNext).not.toHaveBeenCalled();
    expect(f.mocks.provide).not.toHaveBeenCalled();
  });
});
