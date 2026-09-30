import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReportMetadataCursors } from './report-metadata-cursor.js';
describe('opaque report metadata cursors', () => {
  it('binds exact microsecond positions to admin, actor, status and expiry', async () => {
    const values = new Map<string, string>();
    let now = 1000;
    const cursors = new ReportMetadataCursors(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 1),
      () => now,
    );
    const viewer = { adminUserId: randomUUID(), actorUserId: randomUUID() };
    const position = {
      priority: 'threshold' as const,
      submittedAt: '2026-09-28T01:00:00.000123Z',
      reportId: randomUUID(),
    };
    const token = await cursors.issue(viewer, 'pending_review', position);
    expect(token).toMatch(/^v1\.m7\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(token).not.toContain(position.reportId);
    expect(await cursors.resolve(token, viewer, 'pending_review')).toEqual(position);
    expect(
      await cursors.resolve(token, { ...viewer, adminUserId: randomUUID() }, 'pending_review'),
    ).toBeUndefined();
    expect(
      await cursors.resolve(token, { ...viewer, actorUserId: randomUUID() }, 'pending_review'),
    ).toBeUndefined();
    expect(await cursors.resolve(token, viewer, 'dismissed')).toBeUndefined();
    expect(await cursors.resolve(`${token}x`, viewer, 'pending_review')).toBeUndefined();
    now = 301000;
    expect(await cursors.resolve(token, viewer, 'pending_review')).toBeUndefined();
  });
  it('fails closed on missing, malformed or wrong-purpose server state and exhausted allocation', async () => {
    let state: string | undefined;
    const cursors = new ReportMetadataCursors(
      {
        get: () => Promise.resolve(state),
        putIfAbsent: (_id, value) => {
          state = value;
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 2),
    );
    const viewer = { adminUserId: randomUUID(), actorUserId: randomUUID() };
    const position = {
      priority: 'normal' as const,
      submittedAt: '2026-09-28T01:00:00.123456Z',
      reportId: randomUUID(),
    };
    const token = await cursors.issue(viewer, 'pending_review', position);
    const original = state!;
    for (const value of [
      undefined,
      'invalid json',
      '[]',
      '{}',
      original.replace('report_metadata', 'another_purpose'),
      original.replace('123456Z', 'invalidZ'),
    ]) {
      state = value;
      expect(await cursors.resolve(token, viewer, 'pending_review')).toBeUndefined();
    }
    const collisions = new ReportMetadataCursors(
      { get: () => Promise.resolve(undefined), putIfAbsent: () => Promise.resolve(false) },
      Buffer.alloc(32, 1),
    );
    await expect(collisions.issue(viewer, 'pending_review', position)).rejects.toThrow(
      'allocation failed',
    );
    await expect(
      cursors.issue(viewer, 'pending_review', { ...position, submittedAt: 'bad' }),
    ).rejects.toThrow('position is invalid');
  });
});
