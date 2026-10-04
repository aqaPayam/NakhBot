import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SafetyMetadataCursors } from './safety-metadata-cursor.js';
describe('safety queue cursors', () => {
  it('preserves microseconds and binds queue, status, actor, admin, state and expiry', async () => {
    let raw: string | undefined,
      now = 1000;
    const cursors = new SafetyMetadataCursors(
      {
        get: () => Promise.resolve(raw),
        putIfAbsent: (_id, value) => {
          raw = value;
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 1),
      () => now,
    );
    const viewer = { adminUserId: randomUUID(), actorUserId: randomUUID() },
      position = { at: '2026-10-04T01:00:00.000123Z', id: randomUUID() };
    const token = await cursors.issue(viewer, 'support', 'open', position);
    expect(token).not.toContain(position.id);
    expect(await cursors.resolve(token, viewer, 'support', 'open')).toEqual(position);
    expect(
      await cursors.resolve(token, { ...viewer, actorUserId: randomUUID() }, 'support', 'open'),
    ).toBeUndefined();
    expect(
      await cursors.resolve(token, { ...viewer, adminUserId: randomUUID() }, 'support', 'open'),
    ).toBeUndefined();
    expect(await cursors.resolve(token, viewer, 'appeals', 'open')).toBeUndefined();
    expect(await cursors.resolve(token, viewer, 'support', 'closed')).toBeUndefined();
    expect(await cursors.resolve(`${token}x`, viewer, 'support', 'open')).toBeUndefined();
    now = 301000;
    expect(await cursors.resolve(token, viewer, 'support', 'open')).toBeUndefined();
    now = 1000;
    const wrongPurpose = JSON.stringify({
      ...(JSON.parse(raw!) as Record<string, unknown>),
      purpose: 'support_action',
    });
    for (const invalid of [undefined, '{', '[]', '{}', wrongPurpose]) {
      raw = invalid;
      expect(await cursors.resolve(token, viewer, 'support', 'open')).toBeUndefined();
    }
    await expect(
      new SafetyMetadataCursors(
        { get: () => Promise.resolve(undefined), putIfAbsent: () => Promise.resolve(false) },
        Buffer.alloc(32, 2),
      ).issue(viewer, 'support', 'open', position),
    ).rejects.toThrow('allocation failed');
  });
});
