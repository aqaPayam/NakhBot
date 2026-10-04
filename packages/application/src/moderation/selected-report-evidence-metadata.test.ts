import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
import type { GetReportEvidenceMetadataHandler } from './report-evidence-metadata.js';
import type { SelectedReportEvidenceMetadataStore } from './selected-report-evidence-metadata.js';
import { GetSelectedReportEvidenceMetadataHandler } from './selected-report-evidence-metadata.js';

function fixture(): {
  actor: { kind: 'admin'; userId: string };
  adminId: string;
  query: Parameters<GetSelectedReportEvidenceMetadataHandler['execute']>[0];
  facts: NonNullable<Awaited<ReturnType<SelectedReportEvidenceMetadataStore['get']>>>;
  issue: ReturnType<typeof vi.fn<AdminActionAuthorizationService['issue']>>;
  authorize: ReturnType<typeof vi.fn<AdminActionAuthorizationService['authorize']>>;
  identity: ReturnType<typeof vi.fn<AdminQueueIdentityStore['get']>>;
  get: ReturnType<typeof vi.fn<SelectedReportEvidenceMetadataStore['get']>>;
  execute: ReturnType<typeof vi.fn<GetReportEvidenceMetadataHandler['execute']>>;
  handler: GetSelectedReportEvidenceMetadataHandler;
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
  };
  const get = vi.fn<SelectedReportEvidenceMetadataStore['get']>(() => Promise.resolve(facts));
  const reportId = randomUUID(),
    evidenceId = randomUUID();
  const execute = vi.fn<GetReportEvidenceMetadataHandler['execute']>(() =>
    Promise.resolve({
      reportId,
      items: [{ evidenceId, evidenceType: 'photo', snapshotSchemaVersion: 1 }],
    }),
  );
  const issue = vi.fn<AdminActionAuthorizationService['issue']>(() =>
    Promise.resolve('metadata-token'),
  );
  const query = {
    actor,
    requestId: randomUUID(),
    adminActionToken: 'queue-token',
    reportId,
    expectedReportVersion: 2,
  };
  return {
    actor,
    adminId,
    query,
    facts,
    authorize,
    issue,
    identity,
    get,
    execute,
    handler: new GetSelectedReportEvidenceMetadataHandler(
      { authorize, issue },
      { get: identity },
      { get },
      { execute },
    ),
  };
}
describe('server-derived selected report evidence metadata', () => {
  it('derives governing review/version and returns only only metadata, ignoring forged direct identities', async () => {
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
    expect(result).toEqual(await f.execute(f.execute.mock.calls[0]![0], f.actor));
    expect(f.issue.mock.calls[0]![0]).toMatchObject({
      actorUserId: f.actor.userId,
      scope: {
        commandCode: 'moderation.evidence-metadata',
        targetType: 'report',
        targetId: f.query.reportId,
        expectedTargetVersion: 2,
        requiredPermission: 'view_reports',
      },
    });
    expect(f.execute).toHaveBeenCalledWith(
      { actor: f.actor, requestId: f.query.requestId, adminActionToken: 'metadata-token' },
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
    f.get.mockResolvedValueOnce({ ...f.facts, reportStatus: 'unsupported' });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ status: 500 });
    f.identity.mockResolvedValueOnce(undefined);
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    f.identity.mockResolvedValueOnce({ adminUserId: randomUUID(), telegramUserId: '123456789' });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('rechecks report stability and rejects wrong-report or oversized metadata results', async () => {
    const f = fixture();
    for (const changed of [
      undefined,
      { ...f.facts, reportVersion: 3 },
      { ...f.facts, reportStatus: 'dismissed' },
    ]) {
      f.get.mockResolvedValueOnce(f.facts).mockResolvedValueOnce(changed);
      await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
        code: 'version_conflict',
      });
    }
    f.execute.mockResolvedValueOnce({ reportId: randomUUID(), items: [] });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ status: 500 });
    f.execute.mockResolvedValueOnce({
      reportId: f.query.reportId,
      items: Array.from({ length: 6 }, () => ({
        evidenceId: randomUUID(),
        evidenceType: 'photo',
        snapshotSchemaVersion: 1,
      })),
    });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ status: 500 });
    f.execute.mockRejectedValueOnce({ code: 'forbidden', status: 403 });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ status: 403 });
  });
});

describe('terminal/submitted evidence metadata remains available', () => {
  it('does not require review assignment or decision state for metadata browsing', async () => {
    const f = fixture();
    for (const reportStatus of ['submitted', 'pending_review', 'dismissed', 'actioned', 'closed']) {
      f.get
        .mockResolvedValueOnce({ ...f.facts, reportStatus })
        .mockResolvedValueOnce({ ...f.facts, reportStatus });
      expect(await f.handler.execute(f.query, f.actor)).toMatchObject({
        reportId: f.query.reportId,
      });
    }
  });
});
