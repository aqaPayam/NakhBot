import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GetReportMetadataPageQuery } from '@nakh/contracts';
import { GetReportMetadataPageHandler } from './report-metadata.js';

describe('authenticated report metadata pages', () => {
  it('rejects actor mismatch, oversized pages and invalid cursors before reading metadata', async () => {
    const query: GetReportMetadataPageQuery = {
      actor: { kind: 'admin', userId: randomUUID() },
      requestId: randomUUID(),
      adminActionToken: 'opaque',
      limit: 2,
    };
    const authorization = {
      authorize: vi.fn().mockResolvedValue({
        adminUserId: randomUUID(),
        actorUserId: query.actor.userId,
        targetId: null,
        expectedTargetVersion: null,
      }),
    };
    const store = { page: vi.fn() };
    const cursors = { issue: vi.fn(), resolve: vi.fn().mockResolvedValue(undefined) };
    const handler = new GetReportMetadataPageHandler(authorization, store, cursors);
    await expect(
      handler.execute(query, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(handler.execute({ ...query, limit: 51 }, query.actor)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(authorization.authorize).not.toHaveBeenCalled();
    await expect(
      handler.execute({ ...query, cursor: 'forged' }, query.actor),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(store.page).not.toHaveBeenCalled();
  });
  it('requires a queue-scoped authorization and issues only a bound next cursor', async () => {
    const query: GetReportMetadataPageQuery = {
      actor: { kind: 'admin', userId: randomUUID() },
      requestId: randomUUID(),
      adminActionToken: 'opaque',
      limit: 2,
    };
    const adminId = randomUUID();
    const action = {
      adminUserId: adminId,
      actorUserId: query.actor.userId,
      targetId: null,
      expectedTargetVersion: null,
    };
    const authorization = { authorize: vi.fn().mockResolvedValue(action) };
    const position = {
      priority: 'normal' as const,
      submittedAt: '2026-09-28T01:00:00.123456Z',
      reportId: randomUUID(),
    };
    const store = { page: vi.fn().mockResolvedValue({ items: [], next: position }) };
    const cursors = { issue: vi.fn().mockResolvedValue('opaque-next'), resolve: vi.fn() };
    const handler = new GetReportMetadataPageHandler(authorization, store, cursors);
    expect(await handler.execute(query, query.actor)).toEqual({
      items: [],
      nextCursor: 'opaque-next',
    });
    expect(authorization.authorize).toHaveBeenCalledWith({
      actor: query.actor,
      token: query.adminActionToken,
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
    });
    expect(cursors.issue).toHaveBeenCalledWith(
      { adminUserId: adminId, actorUserId: query.actor.userId },
      'pending_review',
      position,
    );
    authorization.authorize.mockResolvedValue({ ...action, targetId: randomUUID() });
    await expect(handler.execute(query, query.actor)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(store.page).toHaveBeenCalledTimes(1);
  });
});
