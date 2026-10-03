import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReportTokens } from './report-tokens.js';

describe('report source and evidence intent tokens', () => {
  it('binds opaque message contexts to their actor and forbids mixed photo selections', async () => {
    const state = new Map<string, string>(),
      actor = randomUUID(),
      messageId = randomUUID();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(state.get(id)),
        putIfAbsent: (id, value) => {
          state.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 31),
    );
    const source = { kind: 'message' as const, referenceId: messageId },
      issued = await tokens.issueSource(actor, source);
    expect(await tokens.resolveSource(issued.token, actor)).toEqual(source);
    expect(await tokens.resolveSource(issued.token, randomUUID())).toBeUndefined();
    expect(issued.token).not.toContain(messageId);
    await expect(tokens.issueSource(actor, { ...source, photoId: randomUUID() })).rejects.toThrow(
      'context is invalid',
    );
  });
  it('keeps identities opaque and binds purpose, actor, signature and exact expiry', async () => {
    let now = 1000;
    const state = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(state.get(id)),
        putIfAbsent: (id, value, ttl) => {
          expect(ttl).toBe(300);
          state.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 9),
      () => now,
    );
    const actor = randomUUID(),
      target = randomUUID();
    const source = { kind: 'received_like' as const, referenceId: randomUUID() };
    const intent = {
      source,
      targetUserId: target,
      evidence: [{ evidenceType: 'profile' as const, referenceId: randomUUID() }],
    };
    const s = await tokens.issueSource(actor, source),
      i = await tokens.issueIntent(actor, intent);
    expect(s.token).toMatch(/^v1\.rs\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(i.token).toMatch(/^v1\.ri\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    for (const id of [actor, target, source.referenceId, intent.evidence[0]!.referenceId])
      expect(s.token + i.token).not.toContain(id);
    expect(await tokens.resolveSource(s.token, actor)).toEqual(source);
    expect(await tokens.resolveIntent(i.token, actor)).toEqual(intent);
    expect(await tokens.resolveSource(i.token, actor)).toBeUndefined();
    expect(await tokens.resolveIntent(s.token, actor)).toBeUndefined();
    expect(await tokens.resolveIntent(i.token, target)).toBeUndefined();
    expect(await tokens.resolveSource(s.token, target)).toBeUndefined();
    expect(
      await tokens.resolveIntent(
        `${i.token.slice(0, -1)}${i.token.endsWith('A') ? 'B' : 'A'}`,
        actor,
      ),
    ).toBeUndefined();
    now = 301000;
    expect(await tokens.resolveSource(s.token, actor)).toBeUndefined();
    expect(await tokens.resolveIntent(i.token, actor)).toBeUndefined();
  });
  it('rejects malformed state, unsupported evidence, self targets and duplicate evidence types', async () => {
    let raw: string | undefined;
    const tokens = new ReportTokens(
      {
        get: () => Promise.resolve(raw),
        putIfAbsent: (_id, value) => {
          raw = value;
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 1),
    );
    const actor = randomUUID();
    const value = {
      source: { kind: 'match' as const, referenceId: randomUUID() },
      targetUserId: randomUUID(),
      evidence: [{ evidenceType: 'chat' as const, referenceId: randomUUID() }],
    };
    const { token } = await tokens.issueIntent(actor, value);
    const original = raw!;
    for (const state of [
      undefined,
      '[]',
      '{}',
      '{',
      original.replace('"ri"', '"rs"'),
      original.replace('"chat"', '"nakh"'),
      original.replace(value.targetUserId, actor),
    ]) {
      raw = state;
      expect(await tokens.resolveIntent(token, actor)).toBeUndefined();
    }
    await expect(tokens.issueIntent(actor, { ...value, targetUserId: actor })).rejects.toThrow(
      'context is invalid',
    );
    await expect(
      tokens.issueIntent(actor, { ...value, evidence: [...value.evidence, ...value.evidence] }),
    ).rejects.toThrow('context is invalid');
    const collisions = new ReportTokens(
      { get: () => Promise.resolve(undefined), putIfAbsent: () => Promise.resolve(false) },
      Buffer.alloc(32, 1),
    );
    await expect(collisions.issueSource(actor, value.source)).rejects.toThrow('allocation failed');
  });
});
