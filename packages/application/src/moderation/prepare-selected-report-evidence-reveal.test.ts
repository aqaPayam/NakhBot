import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ReportEvidenceActions } from '@nakh/contracts';
import { PrepareSelectedReportEvidenceRevealHandler } from './prepare-selected-report-evidence-reveal.js';
import {
  GetSelectedReportEvidenceMetadataHandler,
  type SelectedReportEvidenceMetadataStore,
} from './selected-report-evidence-metadata.js';
import type { GetReportEvidenceActionsHandler } from './report-evidence-actions.js';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';

function fixture(): {
  actor: { kind: 'admin'; userId: string };
  query: Parameters<PrepareSelectedReportEvidenceRevealHandler['execute']>[0];
  authorize: ReturnType<typeof vi.fn<AdminActionAuthorizationService['authorize']>>;
  issue: ReturnType<typeof vi.fn<AdminActionAuthorizationService['issue']>>;
  get: ReturnType<typeof vi.fn<SelectedReportEvidenceMetadataStore['get']>>;
  result: ReportEvidenceActions;
  execute: ReturnType<typeof vi.fn<GetReportEvidenceActionsHandler['execute']>>;
  handler: PrepareSelectedReportEvidenceRevealHandler;
} {
  const actor = { kind: 'admin' as const, userId: randomUUID() },
    adminId = randomUUID();
  const query = {
    actor,
    requestId: randomUUID(),
    adminActionToken: 'queue-root',
    reportId: randomUUID(),
    expectedReportVersion: 1,
    evidenceId: randomUUID(),
  };
  const root = {
    adminUserId: adminId,
    actorUserId: actor.userId,
    commandCode: 'moderation.report-metadata',
    requiredPermission: 'view_reports' as const,
    targetType: 'report_queue',
    targetId: null,
    expectedTargetVersion: null,
  };
  const authorize = vi.fn<AdminActionAuthorizationService['authorize']>(() =>
    Promise.resolve(root),
  );
  const issue = vi.fn<AdminActionAuthorizationService['issue']>(() =>
    Promise.resolve('report-token'),
  );
  const get = vi.fn(() =>
    Promise.resolve<{ reportVersion: number; reportStatus: string } | undefined>({
      reportVersion: 1,
      reportStatus: 'submitted',
    }),
  );
  const result: ReportEvidenceActions = {
    reportId: query.reportId,
    items: [
      {
        evidenceId: query.evidenceId,
        evidenceType: 'photo',
        snapshotSchemaVersion: 1,
        revealActionToken: 'native-reveal-token',
      },
    ],
  };
  const execute = vi.fn(() => Promise.resolve(result));
  const handler = new PrepareSelectedReportEvidenceRevealHandler(
    new GetSelectedReportEvidenceMetadataHandler(
      { authorize, issue },
      { get: () => Promise.resolve({ adminUserId: adminId, telegramUserId: '123456789' }) },
      { get },
      { execute },
    ),
  );
  return { actor, query, authorize, issue, get, result, execute, handler };
}
describe('selected Report native evidence reveal preparation', () => {
  it('derives report authority and returns only the exact supported immutable evidence grant under concurrent preparation', async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => f.handler.execute(f.query, f.actor)),
    );
    expect(
      results.every(
        (result) =>
          JSON.stringify(result) === JSON.stringify({ adminActionToken: 'native-reveal-token' }),
      ),
    ).toBe(true);
    expect(f.issue).toHaveBeenCalledWith({
      actorUserId: f.actor.userId,
      telegramUserId: '123456789',
      scope: {
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: f.query.reportId,
        expectedTargetVersion: 1,
      },
    });
    expect(f.execute).toHaveBeenCalledWith(
      { actor: f.actor, requestId: f.query.requestId, adminActionToken: 'report-token' },
      f.actor,
    );
  });
  it('rejects borrowed evidence, missing reader support, unsupported schema and duplicate selection', async () => {
    const f = fixture();
    await expect(
      f.handler.execute({ ...f.query, evidenceId: randomUUID() }, f.actor),
    ).rejects.toMatchObject({ code: 'not_found' });
    f.execute.mockResolvedValueOnce({
      ...f.result,
      items: [{ evidenceId: f.query.evidenceId, evidenceType: 'photo', snapshotSchemaVersion: 1 }],
    });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    f.execute.mockResolvedValueOnce({
      ...f.result,
      items: [{ ...f.result.items[0]!, snapshotSchemaVersion: 2 }],
    });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    f.execute.mockResolvedValueOnce({
      ...f.result,
      items: [f.result.items[0]!, f.result.items[0]!],
    });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ status: 500 });
  });
  it('rechecks actor, current permission and Report stability and propagates native failures', async () => {
    const f = fixture();
    await expect(
      f.handler.execute(f.query, { ...f.actor, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.execute).not.toHaveBeenCalled();
    f.authorize.mockRejectedValueOnce({ code: 'forbidden', status: 403 });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
    f.get
      .mockResolvedValueOnce({ reportVersion: 1, reportStatus: 'submitted' })
      .mockResolvedValueOnce({ reportVersion: 2, reportStatus: 'pending_review' });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    f.execute.mockRejectedValueOnce({ code: 'forbidden', status: 403 });
    await expect(f.handler.execute(f.query, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
