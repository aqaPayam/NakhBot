import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RecordAdminIngressRejectionHandler,
  type AdminIngressRejectionStore,
} from './admin-ingress-rejection.js';

describe('authenticated admin ingress rejection capability', () => {
  it('accepts only authenticated admin contexts with bounded IDs, digests and route scope', async () => {
    const record = vi.fn<AdminIngressRejectionStore['record']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'rejected',
        safeCode: 'invalid_request',
        recordedAt: new Date(),
        replayed: false,
        value: undefined,
      }),
    );
    const handler = new RecordAdminIngressRejectionHandler({ record });
    const input = {
      actor: { kind: 'admin' as const, userId: randomUUID() },
      commandId: randomUUID(),
      requestId: randomUUID(),
      requestDigest: createHash('sha256').update('private malformed fixture').digest('hex'),
      commandCode: 'moderation.reveal-evidence',
      requiredPermission: 'view_reports' as const,
    };
    await handler.record(input);
    expect(record).toHaveBeenCalledWith(input);
    for (const changed of [
      { ...input, actor: { ...input.actor, kind: 'user' as const } },
      { ...input, commandId: 'invalid' },
      { ...input, requestDigest: 'private fixture' },
      { ...input, commandCode: 'private code with spaces' },
    ])
      expect(() => handler.record(changed)).toThrow();
    expect(record).toHaveBeenCalledTimes(1);
  });
});
