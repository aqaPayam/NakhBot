import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
import type { PrepareReportPhotoActionHandler } from './prepare-report-photo-action.js';
import type { SelectedReportReviewStore } from './prepare-selected-report-review.js';
import { PrepareSelectedReportPhotoActionHandler } from './prepare-selected-report-photo-action.js';

function fixture(): {
  actor: { kind: 'admin'; userId: string };
  adminId: string;
  query: Parameters<PrepareSelectedReportPhotoActionHandler['execute']>[0];
  facts: NonNullable<Awaited<ReturnType<SelectedReportReviewStore['get']>>>;
  authorize: ReturnType<typeof vi.fn<AdminActionAuthorizationService['authorize']>>;
  identity: ReturnType<typeof vi.fn<AdminQueueIdentityStore['get']>>;
  get: ReturnType<typeof vi.fn<SelectedReportReviewStore['get']>>;
  execute: ReturnType<typeof vi.fn<PrepareReportPhotoActionHandler['execute']>>;
  handler: PrepareSelectedReportPhotoActionHandler;
} {
  const actor = { kind: 'admin' as const, userId: randomUUID() },
    adminId = randomUUID();
  const authorize = vi.fn<AdminActionAuthorizationService['authorize']>(() =>
    Promise.resolve({
      adminUserId: adminId,
      actorUserId: actor.userId,
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
      targetId: null,
      expectedTargetVersion: null,
    }),
  );
  const identity = vi.fn<AdminQueueIdentityStore['get']>(() =>
    Promise.resolve({ adminUserId: adminId, telegramUserId: '123456789' }),
  );
  const facts = {
    reportVersion: 2,
    reportStatus: 'pending_review',
    reviewId: randomUUID(),
    reviewVersion: 7,
  };
  const get = vi.fn<SelectedReportReviewStore['get']>(() => Promise.resolve(facts));
  const execute = vi.fn<PrepareReportPhotoActionHandler['execute']>(() =>
    Promise.resolve({ adminActionToken: 'native-token', photoVersion: 3 }),
  );
  const query = {
    actor,
    requestId: randomUUID(),
    adminActionToken: 'queue-token',
    reportId: randomUUID(),
    expectedReportVersion: 2,
    evidenceId: randomUUID(),
    action: 'hide_photo' as const,
  };
  return {
    actor,
    adminId,
    query,
    facts,
    authorize,
    identity,
    get,
    execute,
    handler: new PrepareSelectedReportPhotoActionHandler(
      { authorize },
      { get: identity },
      { get },
      { execute },
    ),
  };
}
describe('server-derived selected report photo authority', () => {
  it('derives governing review/version and returns only native photo authority, ignoring forged direct identities', async () => {
    const f = fixture();
    const result = await f.handler.execute(
      {
        ...f.query,
        ...{
          reviewId: randomUUID(),
          expectedReviewVersion: 999,
          targetUserId: randomUUID(),
          expectedAccountVersion: 999,
          sourceReportId: randomUUID(),
        },
      },
      f.actor,
    );
    expect(result).toEqual({
      adminActionToken: 'native-token',
      photoVersion: 3,
    });
    expect(f.execute).toHaveBeenCalledWith(
      {
        actor: f.actor,
        requestId: f.query.requestId,
        adminActionToken: 'queue-token',
        reviewId: f.facts.reviewId,
        expectedReviewVersion: 7,
        action: 'hide_photo',
        evidenceId: f.query.evidenceId,
      },
      f.actor,
    );
    expect(f.authorize).toHaveBeenCalledWith({
      actor: f.actor,
      token: 'queue-token',
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
    });
    expect(f.get).toHaveBeenCalledWith(f.query.reportId);
  });
  it('denies user/cross-actor, scoped roots, malformed versions and unknown actions before selection', async () => {
    const f = fixture();
    await expect(
      f.handler.execute(f.query, { kind: 'user', userId: f.actor.userId }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      f.handler.execute(f.query, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.authorize).not.toHaveBeenCalled();
    for (const expectedReportVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        f.handler.execute({ ...f.query, expectedReportVersion }, f.actor),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      f.handler.execute({ ...f.query, action: 'assign' as 'hide_photo' }, f.actor),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const root = await f.authorize(f.authorize.mock.calls[0]![0]);
    f.authorize.mockResolvedValueOnce({ ...root, targetId: randomUUID() });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    f.authorize.mockResolvedValueOnce({ ...root, expectedTargetVersion: 1 });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('rejects missing/stale/terminal reports and mismatched current admin identity without issuing target authority', async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(undefined);
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      f.handler.execute({ ...f.query, expectedReportVersion: 1 }, f.actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    f.get.mockResolvedValueOnce({ ...f.facts, reportStatus: 'dismissed' });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'conflict' });
    f.identity.mockResolvedValueOnce(undefined);
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    f.identity.mockResolvedValueOnce({ adminUserId: randomUUID(), telegramUserId: '123456789' });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('delegates each permission/ownership/action check and detects a changed governing report or review during native preparation', async () => {
    const f = fixture();
    for (const action of ['hide_photo', 'restore_photo', 'delete_photo'] as const) {
      await f.handler.execute({ ...f.query, action }, f.actor);
      expect(f.execute.mock.calls.at(-1)![0]).toMatchObject({
        action,
        reviewId: f.facts.reviewId,
        expectedReviewVersion: 7,
      });
    }
    f.execute.mockRejectedValueOnce({ code: 'forbidden', status: 403 });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    for (const changed of [
      undefined,
      { ...f.facts, reportVersion: 3 },
      { ...f.facts, reportStatus: 'dismissed' },
      { ...f.facts, reviewId: randomUUID() },
      { ...f.facts, reviewVersion: 8 },
    ]) {
      f.get.mockResolvedValueOnce(f.facts).mockResolvedValueOnce(changed);
      await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
        code: 'version_conflict',
      });
    }
  });
});
