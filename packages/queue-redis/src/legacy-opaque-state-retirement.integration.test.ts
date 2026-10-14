import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { LegacyOpaqueRetirementAudit } from '@nakh/application';
import {
  createRedisConnection,
  RedisLegacyOpaqueStateRetirement,
  RedisOpaqueTokenStore,
  RedisOwnedOpaqueTokenStore,
} from './index.js';

const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)('legacy opaque namespace retirement with actual Redis', () => {
  const redis = createRedisConnection(url ?? 'redis://invalid');
  afterAll(async () => {
    await redis.quit();
  });
  function scene(): {
    prefix: string;
    retire: RedisLegacyOpaqueStateRetirement;
    legacy: RedisOpaqueTokenStore;
    current: RedisOpaqueTokenStore;
    authorized: string[];
    observed: string[];
    audit: LegacyOpaqueRetirementAudit;
  } {
    const prefix = `m8-legacy-action-${randomUUID()}`,
      authorized: string[] = [],
      observed: string[] = [];
    const audit: LegacyOpaqueRetirementAudit = {
      prepare: (input) => {
        const id = randomUUID();
        authorized.push(JSON.stringify({ id, ...input }));
        return Promise.resolve(id);
      },
      observe: (id, value) => {
        observed.push(JSON.stringify({ id, ...value }));
        return Promise.resolve();
      },
    };
    return {
      prefix,
      audit,
      authorized,
      observed,
      retire: new RedisLegacyOpaqueStateRetirement(redis, prefix, audit),
      legacy: new RedisOpaqueTokenStore(redis, prefix, 1),
      current: new RedisOpaqueTokenStore(redis, prefix),
    };
  }
  async function drain(retire: RedisLegacyOpaqueStateRetirement, limit = 100): Promise<number> {
    let cursor = '0',
      removed = 0;
    for (let i = 0; i < 10000; i++) {
      const result = await retire.revokeNext(cursor, limit);
      expect(result.removed).toBeLessThanOrEqual(limit);
      removed += result.removed;
      cursor = result.nextCursor;
      if (!result.hasMore) return removed;
    }
    throw new Error('Legacy retirement did not converge.');
  }
  async function absent(retire: RedisLegacyOpaqueStateRetirement): Promise<boolean> {
    let cursor = '0',
      found = 0;
    for (let i = 0; i < 10000; i++) {
      const page = await retire.verifyNext(cursor);
      found += page.found;
      cursor = page.nextCursor;
      if (!page.hasMore) return found === 0;
    }
    throw new Error('Independent absence scan did not converge.');
  }
  it('removes legacy public and internal bodies while preserving current UI and owning lifetime values', async () => {
    const f = scene(),
      id = 'abcdefghijklmnop',
      internal = `telegram-report:${'a'.repeat(22)}`;
    await f.legacy.putIfAbsent(id, 'old private body', 60);
    await f.legacy.putIfAbsent(internal, 'old private UI body', 60);
    expect(await f.current.get(id)).toBeUndefined();
    await f.current.putIfAbsent(id, 'current UI', 60);
    const owned = new RedisOwnedOpaqueTokenStore(redis, f.prefix, {
      userId: randomUUID(),
      productEpoch: 0,
    });
    await owned.putIfAbsent(id, 'owning product life', 60);
    expect(await f.current.get(id)).toBe('current UI');
    expect(await drain(f.retire)).toBe(2);
    expect(await absent(f.retire)).toBe(true);
    expect(await f.legacy.get(id)).toBeUndefined();
    expect(await f.current.get(id)).toBe('current UI');
    expect(await owned.get(id)).toBe('owning product life');
    expect(await redis.pttl(`${f.prefix}:legacy-action-retired`)).toBe(-1);
    expect(JSON.stringify([...f.authorized, ...f.observed])).not.toContain('private');
    await redis.del(`${f.prefix}:action-v2:${id}`);
    await owned.revokeNext();
  });
  it('drains 205 opaque values in batches of at most seven and rescans independently after interruption', async () => {
    const f = scene();
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        f.legacy.putIfAbsent(i.toString(16).padStart(16, '0'), 'encrypted legacy value', 60),
      ),
    );
    const first = await f.retire.revokeNext('0', 7);
    expect(first.removed).toBeLessThanOrEqual(7);
    expect(first.removed + (await drain(f.retire, 7))).toBe(205);
    expect(await absent(f.retire)).toBe(true);
    expect(await drain(f.retire, 7)).toBe(0);
  });
  it('rejects late current-code legacy producers after fencing under twenty concurrent write races', async () => {
    const f = scene();
    await Promise.allSettled([
      ...Array.from({ length: 20 }, (_, i) =>
        f.legacy.putIfAbsent(i.toString(16).padStart(16, '0'), 'racing value', 60),
      ),
      f.retire.revokeNext(),
      ...Array.from({ length: 20 }, (_, i) =>
        f.legacy.putIfAbsent((i + 20).toString(16).padStart(16, '0'), 'late value', 60),
      ),
    ]);
    await drain(f.retire);
    await expect(f.legacy.putIfAbsent('abcdefghijklmnop', 'late private body', 60)).rejects.toThrow(
      /unavailable/,
    );
    expect(await absent(f.retire)).toBe(true);
    expect(await f.current.putIfAbsent('abcdefghijklmnop', 'current UI', 60)).toBe(true);
    await redis.del(`${f.prefix}:action-v2:abcdefghijklmnop`);
  });
  it('never opens malformed, foreign-looking or encrypted bodies to infer ownership', async () => {
    const f = scene();
    await redis.hset(`${f.prefix}:action:unknown-shape`, { body: 'private encrypted bytes' });
    await redis.lpush(`${f.prefix}:action:internal:${'a'.repeat(64)}`, 'private list body');
    await redis.set(`${f.prefix}:action:abcdefghijklmnop`, 'not valid JSON');
    expect(await drain(f.retire)).toBe(3);
    expect(await absent(f.retire)).toBe(true);
    expect(JSON.stringify([...f.authorized, ...f.observed])).not.toContain('unknown-shape');
  });
  it('requires authorization before installing its fence or removing anything', async () => {
    const f = scene();
    await f.legacy.putIfAbsent('abcdefghijklmnop', 'private body', 60);
    f.audit.prepare = () => Promise.reject(new Error('synthetic audit outage'));
    await expect(f.retire.revokeNext()).rejects.toThrow(/audit outage/);
    expect(await redis.exists(`${f.prefix}:legacy-action-retired`)).toBe(0);
    expect(await f.legacy.get('abcdefghijklmnop')).toBe('private body');
    await redis.del(`${f.prefix}:action:abcdefghijklmnop`);
  });
  it('withholds successful progress after observation loss and safely resumes with independent verification', async () => {
    const f = scene();
    await f.legacy.putIfAbsent('abcdefghijklmnop', 'private body', 60);
    f.audit.observe = () => Promise.reject(new Error('synthetic observation outage'));
    await expect(f.retire.revokeNext()).rejects.toThrow(/observation outage/);
    expect(f.authorized.length).toBeGreaterThan(0);
    expect(f.observed).toHaveLength(0);
    f.audit.observe = () => Promise.resolve();
    await drain(f.retire);
    expect(await absent(f.retire)).toBe(true);
  });
  it('detects a physical orphan after an empty removal pass and rejects expiring or corrupted fences', async () => {
    const f = scene();
    await drain(f.retire);
    await redis.set(`${f.prefix}:action:orphan`, 'unexpected old-runtime value');
    expect(await absent(f.retire)).toBe(false);
    await drain(f.retire);
    await redis.pexpire(`${f.prefix}:legacy-action-retired`, 60000);
    await expect(f.retire.verifyNext()).rejects.toThrow(/unavailable/);
    await drain(f.retire);
    expect(await absent(f.retire)).toBe(true);
    await redis.set(`${f.prefix}:legacy-action-retired`, 'corrupt');
    await expect(f.retire.revokeNext()).rejects.toThrow(/unavailable/);
    await expect(f.retire.verifyNext()).rejects.toThrow(/unavailable/);
  });
  it('exposes only a stable namespace hash and finite audit metadata', async () => {
    const f = scene();
    await f.retire.revokeNext('0', 1);
    const auth = JSON.parse(f.authorized[0]!) as Record<string, unknown>;
    expect(auth.namespaceHash).toBe(f.retire.namespaceHash);
    expect(auth.cursorHash).toBe(createHash('sha256').update('0').digest('hex'));
    expect(Object.keys(auth).sort()).toEqual(['cursorHash', 'id', 'limit', 'namespaceHash']);
    expect(f.retire.namespaceHash).not.toContain(f.prefix);
  });
});
