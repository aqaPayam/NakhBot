import { describe, expect, it } from 'vitest';
import type { OpaqueTokenStore } from '../security/opaque-token.js';
import type { UserSessionActor } from '../security/user-session.js';
import { LikedByOpaqueReferences } from './liked-by-tokens.js';
import { SessionLikedByOpaqueReferences } from './session-liked-by-tokens.js';

class Memory implements OpaqueTokenStore {
  public readonly values = new Map<string, string>();
  public putIfAbsent(id: string, value: string): Promise<boolean> {
    if (this.values.has(id)) return Promise.resolve(false);
    this.values.set(id, value);
    return Promise.resolve(true);
  }
  public get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(id));
  }
}
const key = new Uint8Array(32).fill(9),
  userId = '10000000-0000-4000-8000-000000000001';
const likeId = '20000000-0000-4000-8000-000000000001',
  requestId = '30000000-0000-4000-8000-000000000001';
const actor: UserSessionActor = {
  kind: 'user',
  userId,
  productEpoch: 0,
  sessionGrantId: '40000000-0000-4000-8000-000000000001',
};
const position = { createdAt: new Date('2026-01-02T03:04:05.123Z'), likeId };
function fixture(): {
  store: Memory;
  reader: SessionLikedByOpaqueReferences;
  tokens: SessionLikedByOpaqueReferences;
  advance: (n: number) => void;
} {
  const store = new Memory();
  let now = 1000;
  const reader = SessionLikedByOpaqueReferences.forLife(store, key, actor, () => now);
  return {
    store,
    reader,
    tokens: reader.forSession(actor),
    advance: (n) => {
      now += n;
    },
  };
}
describe('original-session Liked By opaque references', () => {
  it('captures the authenticated original session without exposing identifiers in callbacks', async () => {
    const f = fixture(),
      token = await f.tokens.issueAction(userId, likeId, requestId);
    expect(token).toMatch(/^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).not.toContain(userId);
    expect(token).not.toContain(likeId);
    expect(token).not.toContain(actor.sessionGrantId);
    expect(await f.reader.capture(token)).toEqual({ actor, likeId, purpose: 'liked_by_action' });
    expect(await f.tokens.resolveAction(token, userId)).toBe(likeId);
    expect(await f.reader.resolveAction(token, userId)).toBeUndefined();
  });
  it('keeps cursor purpose and original keyset under the same original session', async () => {
    const f = fixture(),
      token = await f.tokens.issueCursor(userId, position, requestId);
    expect(await f.tokens.resolveCursor(token, userId)).toEqual(position);
    expect(await f.tokens.resolveAction(token, userId)).toBeUndefined();
    expect(await f.reader.capture(token)).toEqual({
      actor,
      likeId,
      purpose: 'liked_by_cursor',
      position,
    });
  });
  it('cannot upgrade an old button by supplying a different current session', async () => {
    const f = fixture(),
      fresh = { ...actor, sessionGrantId: '40000000-0000-4000-8000-000000000002' };
    const token = await f.tokens.issueAction(userId, likeId, requestId),
      newer = f.reader.forSession(fresh);
    expect(await newer.resolveAction(token, userId)).toBeUndefined();
    const freshToken = await newer.issueAction(userId, likeId, requestId);
    expect(freshToken).not.toBe(token);
    expect(await f.tokens.resolveAction(freshToken, userId)).toBeUndefined();
    expect((await f.reader.capture(token))?.actor.sessionGrantId).toBe(actor.sessionGrantId);
  });
  it('authenticates cached session, scope, expiry and exact JSON shape', async () => {
    for (const change of [
      { sessionGrantId: '40000000-0000-4000-8000-000000000002' },
      { likeId: '20000000-0000-4000-8000-000000000002' },
      { expiresAt: 999999999 },
      { extra: 'unreviewed' },
      { version: 1 },
    ]) {
      const f = fixture(),
        token = await f.tokens.issueAction(userId, likeId, requestId),
        id = token.split('.')[2]!;
      const envelope = JSON.parse(f.store.values.get(id)!) as { body: string; mac: string };
      envelope.body = JSON.stringify({ ...(JSON.parse(envelope.body) as object), ...change });
      f.store.values.set(id, JSON.stringify(envelope));
      expect(await f.reader.capture(token)).toBeUndefined();
    }
  });
  it('rejects a valid newer cache envelope copied into an older token slot', async () => {
    const f = fixture(),
      old = await f.tokens.issueAction(userId, likeId, requestId);
    const fresh = await f.reader
      .forSession({ ...actor, sessionGrantId: '40000000-0000-4000-8000-000000000002' })
      .issueAction(userId, likeId, requestId);
    f.store.values.set(old.split('.')[2]!, f.store.values.get(fresh.split('.')[2]!)!);
    expect(await f.reader.capture(old)).toBeUndefined();
  });
  it('preserves one opaque token and original expiry under twenty concurrent retries', async () => {
    const f = fixture(),
      tokens = await Promise.all(
        Array.from({ length: 20 }, () => f.tokens.issueAction(userId, likeId, requestId)),
      );
    expect(new Set(tokens).size).toBe(1);
    expect(f.store.values.size).toBe(1);
    const original = [...f.store.values.values()][0];
    f.advance(899000);
    expect(await f.tokens.issueAction(userId, likeId, requestId)).toBe(tokens[0]);
    expect([...f.store.values.values()][0]).toBe(original);
    f.advance(1000);
    expect(await f.reader.capture(tokens[0]!)).toBeUndefined();
    await expect(f.tokens.issueAction(userId, likeId, requestId)).rejects.toThrow(
      'Liked By reference unavailable.',
    );
  });
  it('rejects another owner, another original life, modified signatures and wrong keys', async () => {
    const f = fixture(),
      token = await f.tokens.issueAction(userId, likeId, requestId);
    for (const reader of [
      SessionLikedByOpaqueReferences.forLife(
        f.store,
        key,
        { ...actor, productEpoch: 1 },
        () => 1000,
      ),
      SessionLikedByOpaqueReferences.forLife(
        f.store,
        key,
        { ...actor, userId: '10000000-0000-4000-8000-000000000002' },
        () => 1000,
      ),
      SessionLikedByOpaqueReferences.forLife(
        f.store,
        new Uint8Array(32).fill(8),
        actor,
        () => 1000,
      ),
    ])
      expect(await reader.capture(token)).toBeUndefined();
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(await f.reader.capture(tampered)).toBeUndefined();
    expect(
      await f.tokens.resolveAction(token, '10000000-0000-4000-8000-000000000002'),
    ).toBeUndefined();
  });
  it('never accepts a legacy reference as a modern session or the reverse', async () => {
    const f = fixture(),
      legacy = LikedByOpaqueReferences.forLife(f.store, key, actor);
    const old = await legacy.issueAction(userId, likeId, requestId),
      modern = await f.tokens.issueAction(userId, likeId, requestId);
    expect(await f.reader.capture(old)).toBeUndefined();
    expect(await legacy.resolveAction(modern, userId)).toBeUndefined();
    await expect(f.reader.issueAction(userId, likeId)).rejects.toThrow(
      'Liked By reference unavailable.',
    );
    expect(() => f.reader.forSession({ ...actor, userId: likeId })).toThrow(
      'Liked By reference unavailable.',
    );
  });
});
