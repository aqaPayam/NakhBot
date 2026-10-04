import { describe, expect, it, vi } from 'vitest';
import type { RunModerationReconciliationBatchHandler } from '@nakh/application';
import { ModerationMaintenance } from './moderation-maintenance.js';

describe('moderation scheduler cadence', () => {
  it('continues bounded progress, delays completed runs, and exposes no durable identifiers', async () => {
    let now = 10;
    const execute = vi
      .fn<RunModerationReconciliationBatchHandler['execute']>()
      .mockResolvedValueOnce({
        runId: 'private-run',
        phase: 'reports',
        scannedCount: 100,
        anomalyCount: 2,
        completed: false,
      })
      .mockResolvedValue({
        runId: 'private-run',
        phase: 'internal_blocks',
        scannedCount: 1,
        anomalyCount: 0,
        completed: true,
      });
    const maintenance = new ModerationMaintenance(
      { execute },
      () => 'proposed-run',
      () => now,
    );
    const first = await maintenance.executeDue();
    expect(first).toEqual({
      outcome: 'in_progress',
      phase: 'reports',
      scannedCount: 100,
      anomalyCount: 2,
      durationMs: 0,
    });
    expect(JSON.stringify(first)).not.toContain('private-run');
    expect(execute).toHaveBeenCalledWith({ proposedRunId: 'proposed-run', limit: 100 });
    await expect(maintenance.executeDue()).resolves.toMatchObject({ outcome: 'completed' });
    now += 15 * 60_000 - 1;
    await expect(maintenance.executeDue()).resolves.toBeUndefined();
    now++;
    await maintenance.executeDue();
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('retries failed work after one minute without logging SQL parameters or losing future progress', async () => {
    let now = 0;
    const execute = vi
      .fn<RunModerationReconciliationBatchHandler['execute']>()
      .mockRejectedValueOnce(new Error('private-user private-support-text SQL parameters'))
      .mockResolvedValue({
        runId: 'private-run',
        phase: 'appeals',
        scannedCount: 0,
        anomalyCount: 0,
        completed: false,
      });
    const maintenance = new ModerationMaintenance(
      { execute },
      () => 'proposed-run',
      () => now,
    );
    const result = await maintenance.executeDue();
    expect(result).toEqual({
      outcome: 'failure',
      phase: 'unknown',
      scannedCount: 0,
      anomalyCount: 0,
      durationMs: 0,
    });
    now = 59_999;
    await expect(maintenance.executeDue()).resolves.toBeUndefined();
    now++;
    await expect(maintenance.executeDue()).resolves.toMatchObject({
      outcome: 'in_progress',
      phase: 'appeals',
    });
  });
  it('does not overlap work within a process while a store call is pending', async () => {
    let complete!: () => void;
    const execute = vi
      .fn<RunModerationReconciliationBatchHandler['execute']>()
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        return {
          runId: 'private-run',
          phase: 'reports',
          scannedCount: 1,
          anomalyCount: 0,
          completed: false,
        };
      });
    const maintenance = new ModerationMaintenance(
      { execute },
      () => 'proposed-run',
      () => 0,
    );
    const pending = maintenance.executeDue();
    await expect(maintenance.executeDue()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    complete();
    await pending;
  });
});
