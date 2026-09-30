import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrepareProfileReportEvidenceHandler } from './prepare-profile-report.js';
import { ReportTokens } from './report-tokens.js';

describe('profile report evidence preparation', () => {
  it('authenticates before resolving context and returns only the bounded opaque intent', async () => {
    const values = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 3),
    );
    const actor = { kind: 'user' as const, userId: randomUUID() };
    const source = { kind: 'received_like' as const, referenceId: randomUUID() };
    const intent = {
      source,
      targetUserId: randomUUID(),
      evidence: [{ evidenceType: 'profile' as const, referenceId: randomUUID() }],
    };
    const resolve = vi.fn(() => Promise.resolve(intent));
    const handler = new PrepareProfileReportEvidenceHandler(tokens, { resolve });
    const query = {
      actor,
      requestId: randomUUID(),
      sourceActionToken: (await tokens.issueSource(actor.userId, source)).token,
      requestedEvidenceTypes: ['profile' as const],
    };
    await expect(handler.execute(query, { ...actor, userId: randomUUID() })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(resolve).not.toHaveBeenCalled();
    const result = await handler.execute(query, actor);
    expect(resolve).toHaveBeenCalledWith(actor.userId, source);
    expect(await tokens.resolveIntent(result.evidenceIntentToken, actor.userId)).toEqual(intent);
    expect(Object.keys(result).sort()).toEqual([
      'evidenceIntentToken',
      'evidenceTypes',
      'expiresAt',
    ]);
    expect(JSON.stringify(result)).not.toContain(intent.targetUserId);
    for (const types of [[], ['photo' as const], ['profile' as const, 'photo' as const]])
      await expect(
        handler.execute({ ...query, requestedEvidenceTypes: types }, actor),
      ).rejects.toMatchObject({ code: 'report_unavailable' });
    await expect(
      handler.execute({ ...query, sourceActionToken: 'forged' }, actor),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    const denied = new PrepareProfileReportEvidenceHandler(tokens, {
      resolve: () => Promise.resolve(undefined),
    });
    await expect(denied.execute(query, actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
  });
});
