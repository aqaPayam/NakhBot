import type { DomainEvent } from '@nakh/contracts';
import { describe, expect, it, vi } from 'vitest';

import { WorkerEventProcessor } from './event-processor.js';

const event: DomainEvent = {
  id: '00000000-0000-4000-8000-000000000010',
  eventType: 'media.ingestion-requested.v1',
  schemaVersion: 1,
  aggregateType: 'media_asset',
  aggregateId: '00000000-0000-4000-8000-000000000020',
  payload: {
    assetId: '00000000-0000-4000-8000-000000000020',
    validationState: 'pending',
  },
  occurredAt: '2026-09-09T00:00:00.000Z',
  correlationId: '00000000-0000-4000-8000-000000000030',
  causationId: '00000000-0000-4000-8000-000000000040',
};

describe('WorkerEventProcessor', () => {
  it('routes a quarantine completion into isolated validation', async () => {
    const validate = vi.fn().mockResolvedValue(undefined);
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      () => 10,
      { execute: validate },
    );
    const uploaded = {
      ...event,
      eventType: 'media.quarantine-uploaded.v1',
      payload: { assetId: event.aggregateId, bytes: 3 },
    };
    await processor.process(uploaded);
    expect(validate).toHaveBeenCalledWith(
      event.aggregateId,
      `worker-instance:validation:${event.id}`,
    );
  });

  it('routes a valid media event with a unique stable delivery owner', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ assetId: event.aggregateId, bytes: 3, sha256: 'a' });
    const recordQuarantineBytes = vi.fn();
    const recordIngestion = vi.fn();
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      { execute },
      { recordQuarantineBytes, recordIngestion },
      () => 10,
    );
    await processor.process(event);
    expect(execute).toHaveBeenCalledWith(event.aggregateId, `worker-instance:media:${event.id}`);
    expect(recordQuarantineBytes).toHaveBeenCalledWith(3);
    expect(recordIngestion).toHaveBeenCalledWith('quarantined', 0);
  });

  it('routes a validated credit increase into FIFO Pending Nakh settlement', async () => {
    const settle = vi.fn().mockResolvedValue({
      deliveredCount: 1,
      closedCount: 0,
      stopped: 'queue_empty',
    });
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      Date.now,
      undefined,
      undefined,
      undefined,
      { execute: settle },
    );
    const creditTransactionId = '50000000-0000-4000-8000-000000000050';
    const increased: DomainEvent = {
      ...event,
      eventType: 'billing.credit-increased.v1',
      aggregateType: 'credit_account',
      aggregateId: '60000000-0000-4000-8000-000000000060',
      payload: { creditTransactionId, amount: '10', balanceAfter: '10' },
    };
    await processor.process(increased);
    expect(settle).toHaveBeenCalledWith({
      senderUserId: increased.aggregateId,
      triggerCreditTransactionId: creditTransactionId,
      causationId: increased.id,
    });
  });

  it('rejects forged credit-increase facts before settlement', async () => {
    const settle = vi.fn();
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      Date.now,
      undefined,
      undefined,
      undefined,
      { execute: settle },
    );
    await expect(
      processor.process({
        ...event,
        eventType: 'billing.credit-increased.v1',
        aggregateType: 'credit_account',
        payload: {
          creditTransactionId: event.id,
          amount: '-10',
          balanceAfter: '10',
        },
      }),
    ).rejects.toThrow('invalid_credit_increase_event');
    expect(settle).not.toHaveBeenCalled();
  });

  it('retries settlement when a concurrent Stars capture wins the oldest row', async () => {
    const settle = vi.fn().mockResolvedValue({
      deliveredCount: 0,
      closedCount: 0,
      stopped: 'external_funding',
    });
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      Date.now,
      undefined,
      undefined,
      undefined,
      { execute: settle },
    );
    await expect(
      processor.process({
        ...event,
        eventType: 'billing.credit-increased.v1',
        aggregateType: 'credit_account',
        aggregateId: '60000000-0000-4000-8000-000000000060',
        payload: {
          creditTransactionId: '50000000-0000-4000-8000-000000000050',
          amount: '10',
          balanceAfter: '10',
        },
      }),
    ).rejects.toThrow('pending_nakh_external_funding_in_progress');
  });

  it('retries a bounded pass so concurrently admitted rows receive another wake-up', async () => {
    const settle = vi.fn().mockResolvedValue({
      deliveredCount: 5,
      closedCount: 0,
      stopped: 'queue_bound',
    });
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      Date.now,
      undefined,
      undefined,
      undefined,
      { execute: settle },
    );
    await expect(
      processor.process({
        ...event,
        eventType: 'billing.credit-increased.v1',
        aggregateType: 'credit_account',
        aggregateId: '60000000-0000-4000-8000-000000000060',
        payload: {
          creditTransactionId: '50000000-0000-4000-8000-000000000050',
          amount: '10',
          balanceAfter: '10',
        },
      }),
    ).rejects.toThrow('pending_nakh_settlement_pass_incomplete');
  });

  it('rejects forged media event payloads before invoking the handler', async () => {
    const execute = vi.fn();
    const processor = new WorkerEventProcessor({ processSampleEvent: vi.fn() }, 'worker-instance', {
      execute,
    });
    await expect(
      processor.process({ ...event, payload: { ...event.payload, assetId: event.id } }),
    ).rejects.toThrow('invalid_media_ingestion_event');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps media events disabled when the complete dependency chain is absent', async () => {
    const processor = new WorkerEventProcessor({ processSampleEvent: vi.fn() }, 'worker-instance');
    await expect(processor.process(event)).rejects.toThrow('unsupported_worker_event');
  });

  it('routes hidden and deleted photo facts to retry-safe cache revocation', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      Date.now,
      undefined,
      { execute },
    );
    const lifecycle: DomainEvent = {
      ...event,
      aggregateType: 'profile_photo',
      aggregateId: '50000000-0000-4000-8000-000000000050',
      eventType: 'media.photo-hidden.v1',
      payload: {
        profileId: '60000000-0000-4000-8000-000000000060',
        photoId: '50000000-0000-4000-8000-000000000050',
      },
    };
    await processor.process(lifecycle);
    await processor.process({ ...lifecycle, eventType: 'media.photo-deleted.v1' });
    expect(execute).toHaveBeenNthCalledWith(1, lifecycle.aggregateId);
    expect(execute).toHaveBeenNthCalledWith(2, lifecycle.aggregateId);
  });

  it('rejects forged cache revocation facts before invoking the provider', async () => {
    const execute = vi.fn();
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      undefined,
      Date.now,
      undefined,
      { execute },
    );
    await expect(
      processor.process({
        ...event,
        aggregateType: 'profile_photo',
        eventType: 'media.photo-deleted.v1',
        payload: { profileId: event.id, photoId: event.id, unexpected: true },
      }),
    ).rejects.toThrow('invalid_media_cache_revocation_event');
    expect(execute).not.toHaveBeenCalled();
  });

  it('routes deletion to cache revocation and verified object cleanup with a stable owner', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const recordCleanup = vi.fn();
    const recordIngestion = vi.fn();
    const recordQuarantineBytes = vi.fn();
    let now = 0;
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      { recordCleanup, recordIngestion, recordQuarantineBytes },
      () => (now += 5),
      undefined,
      { execute: revoke },
      { execute: cleanup },
    );
    const deleted: DomainEvent = {
      ...event,
      aggregateType: 'profile_photo',
      aggregateId: '50000000-0000-4000-8000-000000000050',
      eventType: 'media.photo-deleted.v1',
      payload: {
        profileId: '60000000-0000-4000-8000-000000000060',
        photoId: '50000000-0000-4000-8000-000000000050',
      },
    };
    await processor.process(deleted);
    expect(revoke).toHaveBeenCalledWith(deleted.aggregateId);
    expect(cleanup).toHaveBeenCalledWith(
      deleted.aggregateId,
      `worker-instance:cleanup:${deleted.id}`,
    );
    expect(recordCleanup).toHaveBeenCalledWith('succeeded', 5);
  });

  it('records a retryable cleanup failure and preserves worker retry semantics', async () => {
    const recordCleanup = vi.fn();
    const processor = new WorkerEventProcessor(
      { processSampleEvent: vi.fn() },
      'worker-instance',
      undefined,
      { recordCleanup, recordIngestion: vi.fn(), recordQuarantineBytes: vi.fn() },
      () => 10,
      undefined,
      undefined,
      { execute: () => Promise.reject(new Error('delete unknown')) },
    );
    const deleted: DomainEvent = {
      ...event,
      aggregateType: 'profile_photo',
      aggregateId: '50000000-0000-4000-8000-000000000050',
      eventType: 'media.photo-deleted.v1',
      payload: {
        profileId: '60000000-0000-4000-8000-000000000060',
        photoId: '50000000-0000-4000-8000-000000000050',
      },
    };
    await expect(processor.process(deleted)).rejects.toThrow('delete unknown');
    expect(recordCleanup).toHaveBeenCalledWith('retryable_failure', 0);
  });
});
