import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AccountDeletionLease, AccountDeletionWorkStore } from './account-deletion.js';
import {
  RunAccountDeletionBatchHandler,
  type AccountDeletionPhaseExecutor,
} from './account-deletion-runtime.js';

const id = '10000000-0000-4000-8000-000000000001';
const lease: AccountDeletionLease = {
  deletionRecordId: id,
  userId: id,
  phase: 'shared_closure',
  checkpointVersion: 1,
  leaseOwner: id,
  leaseGeneration: 1,
  attemptCount: 1,
  leaseExpiresAt: new Date('2030-01-01'),
};
function scene(item: AccountDeletionLease = lease): {
  work: {
    claimDue: Mock<AccountDeletionWorkStore['claimDue']>;
    renew: Mock<AccountDeletionWorkStore['renew']>;
    release: Mock<AccountDeletionWorkStore['release']>;
    retry: Mock<AccountDeletionWorkStore['retry']>;
  };
  executor: { executeNext: Mock<AccountDeletionPhaseExecutor['executeNext']> };
  handler: RunAccountDeletionBatchHandler;
} {
  const work = {
    claimDue: vi.fn<AccountDeletionWorkStore['claimDue']>().mockResolvedValue([item]),
    renew: vi.fn<AccountDeletionWorkStore['renew']>(),
    release: vi.fn<AccountDeletionWorkStore['release']>().mockResolvedValue(undefined),
    retry: vi.fn<AccountDeletionWorkStore['retry']>().mockResolvedValue(undefined),
  };
  const executor = {
    executeNext: vi.fn<AccountDeletionPhaseExecutor['executeNext']>().mockResolvedValue('progress'),
  };
  return { work, executor, handler: new RunAccountDeletionBatchHandler(work, executor, id) };
}
describe('bounded account deletion work runtime', () => {
  it('claims one native lease and releases progress without inventing a checkpoint', async () => {
    const f = scene();
    expect(await f.handler.execute()).toEqual({ outcome: 'progress', phase: 'shared_closure' });
    expect(f.work.claimDue).toHaveBeenCalledExactlyOnceWith({
      workerId: id,
      limit: 1,
      leaseMs: 120000,
    });
    expect(f.work.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(f.work.retry).not.toHaveBeenCalled();
  });
  it('keeps idle work away from providers', async () => {
    const f = scene();
    f.work.claimDue.mockResolvedValue([]);
    expect(await f.handler.execute()).toEqual({ outcome: 'idle', phase: 'unknown' });
    expect(f.executor.executeNext).not.toHaveBeenCalled();
  });
  it('prevents overlapping local polls and drains before closing', async () => {
    const f = scene();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.executor.executeNext.mockImplementation(async () => {
      await gate;
      return 'progress';
    });
    const pending = f.handler.execute();
    await vi.waitFor(() => expect(f.executor.executeNext).toHaveBeenCalledTimes(1));
    expect(await f.handler.execute()).toEqual({ outcome: 'busy', phase: 'unknown' });
    let closed = false;
    const closing = f.handler.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await f.handler.execute()).toEqual({ outcome: 'closed', phase: 'unknown' });
    release();
    await pending;
    await closing;
    expect(f.work.claimDue).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['shared_closure', 1],
    ['evidence_capture', 2],
    ['product_data', 3],
    ['media_objects', 4],
    ['ephemeral_access', 5],
    ['retention_manifest', 6],
    ['verification', 7],
  ] as const)(
    'accepts only native advancement for %s at checkpoint %i',
    async (phase, checkpointVersion) => {
      const f = scene({ ...lease, phase, checkpointVersion });
      const outcome = phase === 'verification' ? 'completed' : 'advanced';
      f.executor.executeNext.mockResolvedValue(outcome);
      expect(await f.handler.execute()).toEqual({ outcome, phase });
      expect(f.work.release).not.toHaveBeenCalled();
      expect(f.work.retry).not.toHaveBeenCalled();
    },
  );
  it.each(['evidence_capture', 'verification'] as const)(
    'backs off blocked %s without hot-looping or claiming completion',
    async (phase) => {
      const f = scene({ ...lease, phase, checkpointVersion: phase === 'verification' ? 7 : 2 });
      f.executor.executeNext.mockResolvedValue('waiting');
      expect(await f.handler.execute()).toEqual({ outcome: 'waiting', phase });
      expect(f.work.retry).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ phase }),
        phase === 'evidence_capture' ? 'deletion_evidence_pending' : 'deletion_verification_failed',
        60,
      );
    },
  );
  it('sanitizes private provider failures and keeps the original retry authority', async () => {
    const f = scene();
    f.executor.executeNext.mockImplementation((scope) => {
      scope.leaseExpiresAt.setTime(0);
      return Promise.reject(new Error('PRIVATE provider body and credentials'));
    });
    expect(await f.handler.execute()).toEqual({
      outcome: 'retry_scheduled',
      phase: 'shared_closure',
    });
    const captured = f.work.retry.mock.calls[0]![0];
    expect(captured.leaseExpiresAt).toEqual(lease.leaseExpiresAt);
    expect(captured.leaseExpiresAt).not.toBe(lease.leaseExpiresAt);
  });
  it('does not undo a checkpoint whose committed response was lost', async () => {
    const f = scene();
    f.executor.executeNext.mockRejectedValue(new Error('PRIVATE response loss'));
    f.work.retry.mockRejectedValue(new Error('PRIVATE changed native checkpoint'));
    expect(await f.handler.execute()).toEqual({ outcome: 'lease_lost', phase: 'shared_closure' });
    expect(f.executor.executeNext).toHaveBeenCalledTimes(1);
    expect(f.work.release).not.toHaveBeenCalled();
  });
  it('does not expose private claim failures', async () => {
    const f = scene();
    f.work.claimDue.mockRejectedValue(new Error('PRIVATE database diagnostic'));
    expect(await f.handler.execute()).toEqual({ outcome: 'failure', phase: 'unknown' });
    expect(f.executor.executeNext).not.toHaveBeenCalled();
  });
  it('rejects an invalid phase/checkpoint before executing a provider', async () => {
    const f = scene({ ...lease, phase: 'verification', checkpointVersion: 5 });
    expect(await f.handler.execute()).toEqual({ outcome: 'retry_scheduled', phase: 'unknown' });
    expect(f.executor.executeNext).not.toHaveBeenCalled();
  });
  it('rejects completion outside the final native checkpoint', async () => {
    const f = scene();
    f.executor.executeNext.mockResolvedValue('completed');
    expect(await f.handler.execute()).toEqual({
      outcome: 'retry_scheduled',
      phase: 'shared_closure',
    });
  });
});
