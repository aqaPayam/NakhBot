import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimModerationReviewsCommand } from '@nakh/contracts';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { ModerationReviewWorkflow } from './review.js';
import { ClaimModerationReviewsHandler } from './claim-reviews.js';

describe('actor-bound queue claims', () => {
  it('audits wrong ownership and expiration, and keeps replay identity stable across transport metadata changes', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID();
    const action = {
      adminUserId,
      actorUserId: actor.userId,
      commandCode: 'moderation.claim-reviews',
      requiredPermission: 'view_reports' as const,
      targetType: 'admin_user',
      targetId: adminUserId,
      expectedTargetVersion: null,
      expiresAt: 2000,
    };
    const resolveAttempt = vi.fn<AdminActionAuthorizationService['resolveAttempt']>(() =>
      Promise.resolve(action),
    );
    const claim = vi.fn<ModerationReviewWorkflow<never>['claim']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'review_queue_empty',
        recordedAt: new Date(),
        replayed: false,
        value: [],
      }),
    );
    const handler = new ClaimModerationReviewsHandler(
      { resolveAttempt },
      { claim },
      { uuid: randomUUID },
      () => 1000,
    );
    const command: ClaimModerationReviewsCommand = {
      actor,
      commandType: 'moderation.claim-reviews',
      commandId: randomUUID(),
      requestId: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      idempotencyKey: randomUUID(),
      data: { adminActionToken: 'opaque-context', limit: 2 },
    };
    await handler.execute(command, actor);
    await handler.execute(
      { ...command, requestId: randomUUID(), locale: 'fa', occurredAt: new Date(0).toISOString() },
      actor,
    );
    expect(claim.mock.calls[0]![0].requestDigest).toBe(claim.mock.calls[1]![0].requestDigest);
    expect(claim.mock.calls[0]![0].metadata).toEqual({});
    resolveAttempt.mockResolvedValueOnce({ ...action, targetId: randomUUID() });
    await handler.execute(command, actor);
    expect(claim.mock.calls[2]![0]).toMatchObject({
      targetId: adminUserId,
      preconditionRejection: 'invalid_request',
    });
    resolveAttempt.mockResolvedValueOnce({ ...action, expiresAt: 999 });
    await handler.execute(command, actor);
    expect(claim.mock.calls[3]![0].preconditionRejection).toBe('invalid_request');
    await expect(
      handler.execute(command, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(claim).toHaveBeenCalledTimes(4);
  });
});
