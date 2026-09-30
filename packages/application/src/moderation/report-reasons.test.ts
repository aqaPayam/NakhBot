import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetReportReasonsHandler } from './report-reasons.js';
describe('authenticated report reason catalog', () => {
  it('rejects actor substitution before reading the catalog', async () => {
    let calls = 0;
    const handler = new GetReportReasonsHandler({
      list: () => {
        calls++;
        return Promise.resolve({ items: [] });
      },
    });
    const actor = { kind: 'user' as const, userId: randomUUID() },
      query = { actor, requestId: randomUUID() };
    expect(() => handler.execute(query, { ...actor, userId: randomUUID() })).toThrow();
    expect(() => handler.execute(query, { ...actor, kind: 'admin' })).toThrow();
    expect(calls).toBe(0);
    await expect(handler.execute(query, actor)).resolves.toEqual({ items: [] });
    expect(calls).toBe(1);
  });
});
