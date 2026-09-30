import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetReportEvidenceActionsHandler } from './report-evidence-actions.js';

describe('supported evidence reveal actions', () => {
  it('does not issue reveal capabilities for unsupported types or future snapshot versions', async () => {
    const reportId = randomUUID(),
      supported = randomUUID(),
      issued: string[] = [];
    const actor = { kind: 'admin' as const, userId: randomUUID() };
    const handler = new GetReportEvidenceActionsHandler(
      {
        execute: () =>
          Promise.resolve({
            reportId,
            items: [
              { evidenceId: supported, evidenceType: 'profile', snapshotSchemaVersion: 1 },
              { evidenceId: randomUUID(), evidenceType: 'profile', snapshotSchemaVersion: 2 },
              { evidenceId: randomUUID(), evidenceType: 'photo', snapshotSchemaVersion: 1 },
            ],
          }),
      },
      (_actor, id) => {
        issued.push(id);
        return Promise.resolve('opaque-action');
      },
    );
    const result = await handler.execute(
      { actor, requestId: randomUUID(), adminActionToken: 'opaque-report' },
      actor,
    );
    expect(issued).toEqual([supported]);
    expect(result.items.map((item) => item.revealActionToken)).toEqual([
      'opaque-action',
      undefined,
      undefined,
    ]);
  });
});
