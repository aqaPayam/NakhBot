import { describe, expect, it, vi } from 'vitest';

import type { IdGenerator } from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import {
  PhotoModerationWorkflow,
  type PhotoModerationWorkflowStore,
  type PhotoModerationWrite,
} from './photo-action.js';

const generated = Array.from(
  { length: 6 },
  (_, index) => `10000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
);

function attempt(overrides: Partial<AdminCommandAttempt> = {}): AdminCommandAttempt {
  return {
    logId: '20000000-0000-7000-8000-000000000001',
    adminUserId: '20000000-0000-7000-8000-000000000002',
    commandId: '20000000-0000-7000-8000-000000000003',
    requestId: '20000000-0000-7000-8000-000000000004',
    requestDigest: 'a'.repeat(64),
    commandCode: 'moderation.apply-photo-action',
    requiredPermission: 'hide_photo',
    targetType: 'photo',
    targetId: '20000000-0000-7000-8000-000000000005',
    expectedTargetVersion: 2,
    reasonDigest: 'b'.repeat(64),
    metadata: {},
    correlationId: '20000000-0000-7000-8000-000000000006',
    ...overrides,
  };
}

function fixture(): Readonly<{
  workflow: PhotoModerationWorkflow<{ transaction: true }>;
  writes: PhotoModerationWrite[];
  order: string[];
  revoke: ReturnType<typeof vi.fn>;
}> {
  let index = 0;
  const ids: IdGenerator = { uuid: () => generated[index++]! };
  const writes: PhotoModerationWrite[] = [];
  const order: string[] = [];
  const photos: PhotoModerationWorkflowStore<{ transaction: true }> = {
    apply: (_context, write) => {
      order.push('effect');
      writes.push(write);
      return Promise.resolve({
        actionId: write.actionId,
        photoId: write.photoId,
        profileId: '30000000-0000-7000-8000-000000000001',
        targetUserId: '30000000-0000-7000-8000-000000000002',
        previousStatus: 'visible',
        nextStatus: 'hidden',
        wasPrimary: true,
        primaryPhotoId: '30000000-0000-7000-8000-000000000003',
        photoVersion: 3,
        profileVersion: 4,
        profileCompletion: 'complete',
      });
    },
  };
  const commands: AdminCommandExecutionStore<{ transaction: true }> = {
    execute: async (commandAttempt, effect) => {
      order.push('command');
      const result = await effect({ transaction: true });
      return {
        logId: commandAttempt.logId,
        result: 'succeeded',
        safeCode: result.safeCode,
        recordedAt: new Date(0),
        replayed: false,
        value: result.value,
      };
    },
    recordEvidenceAccess: () => {
      throw new Error('not used');
    },
  };
  const revoke = vi.fn(() => {
    order.push('revoke');
    return Promise.resolve();
  });
  return {
    workflow: new PhotoModerationWorkflow(commands, photos, { execute: revoke }, ids),
    writes,
    order,
    revoke,
  };
}

describe('photo moderation workflow', () => {
  it('revokes delivery before hide and binds the exact audited M2 write', async () => {
    const context = fixture();
    await expect(context.workflow.apply(attempt(), 'hide_photo')).resolves.toMatchObject({
      result: 'succeeded',
      safeCode: 'photo_hide_photo',
    });
    expect(context.order).toEqual(['revoke', 'command', 'effect']);
    expect(context.writes).toEqual([
      {
        action: 'hide_photo',
        adminUserId: attempt().adminUserId,
        photoId: attempt().targetId,
        expectedPhotoVersion: 2,
        requestId: attempt().requestId,
        commandId: attempt().commandId,
        requestDigest: 'a'.repeat(64),
        reasonCode: 'admin_hide_photo',
        moderationId: generated[0],
        auditId: generated[1],
        eventId: generated[2],
        profileEventId: generated[3],
        actionId: generated[4],
        actionEventId: generated[5],
      },
    ]);
  });

  it('does not purge a restore and rejects mismatched permission before any side effect', async () => {
    const restored = fixture();
    await restored.workflow.apply(
      attempt({ requiredPermission: 'restore_photo' }),
      'restore_photo',
    );
    expect(restored.revoke).not.toHaveBeenCalled();
    expect(restored.order).toEqual(['command', 'effect']);

    const invalid = fixture();
    await expect(
      invalid.workflow.apply(attempt({ requiredPermission: 'delete_photo' }), 'hide_photo'),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(invalid.order).toEqual([]);
  });

  it('passes sanitized purge failure through the audit boundary without a photo write', async () => {
    const context = fixture();
    context.revoke.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(context.workflow.apply(attempt(), 'hide_photo')).rejects.toThrow(
      'Photo delivery revocation unavailable.',
    );
    expect(context.order).toEqual(['command']);
    expect(context.writes).toEqual([]);
  });
});
