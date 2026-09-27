import { describe, expect, it, vi } from 'vitest';

import type {
  AdminCommandAttempt,
  AdminCommandEffectResult,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import { ModerationReviewWorkflow, type ModerationReviewWorkflowStore } from './review.js';

const adminUserId = '10000000-0000-7000-8000-000000000001';
const reviewId = '20000000-0000-7000-8000-000000000001';
const assigneeAdminId = '30000000-0000-7000-8000-000000000001';

function attempt(overrides: Partial<AdminCommandAttempt> = {}): AdminCommandAttempt {
  return {
    logId: '40000000-0000-7000-8000-000000000001',
    adminUserId,
    commandId: '50000000-0000-7000-8000-000000000001',
    requestId: '60000000-0000-7000-8000-000000000001',
    requestDigest: 'a'.repeat(64),
    commandCode: 'moderation.claim-reviews',
    requiredPermission: 'view_reports',
    targetType: 'admin_user',
    targetId: adminUserId,
    expectedTargetVersion: null,
    reasonDigest: 'b'.repeat(64),
    metadata: {},
    correlationId: '70000000-0000-7000-8000-000000000001',
    ...overrides,
  };
}

function fixture(): Readonly<{
  claimSpy: ReturnType<typeof vi.fn>;
  assignSpy: ReturnType<typeof vi.fn>;
  workflow: ModerationReviewWorkflow<{ name: string }>;
}> {
  const context = { name: 'transaction' };
  const commands: AdminCommandExecutionStore<{ name: string }> = {
    async execute<T>(
      commandAttempt: AdminCommandAttempt,
      effect: (context: { name: string }) => Promise<AdminCommandEffectResult<T>>,
    ): Promise<AdminCommandExecutionResult<T>> {
      const result = await effect(context);
      return {
        logId: commandAttempt.logId,
        result: 'succeeded',
        safeCode: result.safeCode,
        recordedAt: new Date('2026-09-27T00:00:00.000Z'),
        replayed: false,
        value: result.value,
      };
    },
    recordEvidenceAccess: () => Promise.reject(new Error('not used')),
  };
  const claimSpy = vi.fn(
    (context: { name: string }, input: Readonly<{ adminUserId: string; limit: number }>) => {
      void context;
      void input;
      return Promise.resolve([
        { reviewId, reportId: reviewId, reviewVersion: 2, priority: 'threshold' as const },
      ]);
    },
  );
  const assignSpy = vi.fn(
    (
      context: { name: string },
      input: Readonly<{
        reviewId: string;
        assigneeAdminId: string;
        expectedVersion: number;
      }>,
    ) => {
      void context;
      return Promise.resolve({
        reviewId: input.reviewId,
        reportId: reviewId,
        assignedAdminId: input.assigneeAdminId,
        reviewVersion: input.expectedVersion + 1,
      });
    },
  );
  const reviews: ModerationReviewWorkflowStore<{ name: string }> = {
    claim: claimSpy,
    assign: assignSpy,
  };
  return {
    claimSpy,
    assignSpy,
    workflow: new ModerationReviewWorkflow(commands, reviews),
  };
}

describe('moderation review workflow', () => {
  it('claims a bounded queue inside the audited command context', async () => {
    const { claimSpy, workflow } = fixture();
    await expect(workflow.claim(attempt(), { limit: 10 })).resolves.toMatchObject({
      result: 'succeeded',
      safeCode: 'reviews_claimed',
      value: [{ reviewId, priority: 'threshold' }],
    });
    expect(claimSpy).toHaveBeenCalledWith({ name: 'transaction' }, { adminUserId, limit: 10 });
  });

  it('requires the exact permission, target scope, version, and assignee shape', async () => {
    const { assignSpy, workflow } = fixture();
    const assignAttempt = attempt({
      commandCode: 'moderation.assign-review',
      targetType: 'moderation_review',
      targetId: reviewId,
      expectedTargetVersion: 2,
    });
    await expect(
      workflow.assign(assignAttempt, { reviewId, assigneeAdminId, expectedVersion: 2 }),
    ).resolves.toMatchObject({ safeCode: 'review_assigned', value: { reviewVersion: 3 } });
    expect(assignSpy).toHaveBeenCalledOnce();
    expect(() =>
      workflow.claim({ ...attempt(), requiredPermission: 'ban_user' }, { limit: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      workflow.assign(assignAttempt, { reviewId, assigneeAdminId, expectedVersion: 3 }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });
});
