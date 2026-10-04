import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import { PrepareReportEvidenceAccessHandler } from './report-evidence-access.js';
describe('selected report evidence access', () => {
  it('binds the current report version and rejects stale selections without allocating new authority', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID(),
      reportId = randomUUID();
    const root = {
      adminUserId,
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
    const handler = new PrepareReportEvidenceAccessHandler(
      { authorize, issue },
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }) },
      { version: () => Promise.resolve(2) },
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: 'queue-token',
      reportId,
      expectedReportVersion: 2,
    };
    expect(await handler.execute(query, actor)).toEqual({
      adminActionToken: 'report-token',
      reportVersion: 2,
    });
    expect(issue).toHaveBeenCalledWith({
      actorUserId: actor.userId,
      telegramUserId: '123456789',
      scope: {
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: reportId,
        expectedTargetVersion: 2,
      },
    });
    await expect(
      handler.execute({ ...query, expectedReportVersion: 1 }, actor),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(issue).toHaveBeenCalledOnce();
    authorize.mockResolvedValueOnce({ ...root, targetId: reportId });
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(issue).toHaveBeenCalledOnce();
  });
});
