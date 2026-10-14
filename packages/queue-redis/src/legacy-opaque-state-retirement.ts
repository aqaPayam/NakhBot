import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { LegacyOpaqueRetirementAudit } from '@nakh/application';

export type LegacyOpaqueSweep = Readonly<{ removed: number; nextCursor: string; hasMore: boolean }>;
export type LegacyOpaqueObservation = Readonly<{
  found: number;
  nextCursor: string;
  hasMore: boolean;
}>;
const CURSOR = /^(0|[1-9][0-9]{0,19})$/u;
function validCursor(cursor: string): boolean {
  return CURSOR.test(cursor) && BigInt(cursor) <= 18446744073709551615n;
}
function unavailable(): never {
  throw new Error('Legacy opaque retirement is unavailable.');
}

/** A global deployment cutover, never an inferred per-user purge. Old ciphertext
 * has no authenticated ownership roster: do not read or decrypt it to find users.
 * v2 unowned UI keys and owned account-life keys use disjoint physical namespaces.
 * Pre-cutover runtimes must be drained before enabling deletion; current v1
 * compatibility writers perform their fence check and write atomically in Redis. */
export class RedisLegacyOpaqueStateRetirement {
  public readonly namespaceHash: string;
  private readonly marker: string;
  private readonly values: string;
  public constructor(
    private readonly redis: Redis,
    prefix: string,
    private readonly audit: LegacyOpaqueRetirementAudit,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(prefix)) unavailable();
    this.marker = `${prefix}:legacy-action-retired`;
    this.values = `${prefix}:action:`;
    this.namespaceHash = createHash('sha256').update(`legacy-opaque-v1\0${prefix}`).digest('hex');
  }
  private validate(cursor: string, limit: number): void {
    if (!validCursor(cursor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      unavailable();
  }
  /** Installs a permanent read/write fence before the first bounded removal.
   * A zero removal count or terminal cursor is not an independent absence proof. */
  public async revokeNext(cursor = '0', limit = 100): Promise<LegacyOpaqueSweep> {
    this.validate(cursor, limit);
    const authorizationId = await this.audit.prepare({
      namespaceHash: this.namespaceHash,
      cursorHash: createHash('sha256').update(cursor).digest('hex'),
      limit,
    });
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        authorizationId,
      )
    )
      unavailable();
    const result = await this.redis.eval(
      `local state = redis.call('GET', KEYS[1])
       if state and state ~= 'retired-v1' then return {-1,'0'} end
       redis.call('SET', KEYS[1], 'retired-v1')
       local page = redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2] .. '*', 'COUNT', 100)
       local keys = page[2]
       for _, key in ipairs(keys) do
         if string.sub(key, 1, string.len(ARGV[2])) ~= ARGV[2] then return {-1,'0'} end
       end
       local removed = 0
       for i=1,math.min(#keys,tonumber(ARGV[3])) do removed = removed + redis.call('DEL',keys[i]) end
       if #keys > tonumber(ARGV[3]) then return {removed,'0',1} end
       return {removed,page[1],page[1] ~= '0' and 1 or 0}`,
      1,
      this.marker,
      cursor,
      this.values,
      limit,
    );
    const page = this.page(result);
    if (page.count > limit) unavailable();
    await this.audit.observe(authorizationId, {
      removed: page.count,
      nextCursorHash: createHash('sha256').update(page.cursor).digest('hex'),
      hasMore: page.hasMore,
    });
    return { removed: page.count, nextCursor: page.cursor, hasMore: page.hasMore };
  }
  /** Read-only, physically independent verification. The owning coordinator must
   * start a NEW full pass at zero, retain all pages and require no findings while
   * the producer fence remains installed. An arbitrary cursor proves nothing.
   * Counts are capped; any positive count blocks completion. No body is read. */
  public async verifyNext(cursor = '0', limit = 100): Promise<LegacyOpaqueObservation> {
    this.validate(cursor, limit);
    const result = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) ~= 'retired-v1' or redis.call('PTTL', KEYS[1]) ~= -1 then return {-1,'0'} end
       local page = redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2] .. '*', 'COUNT', 100)
       for _, key in ipairs(page[2]) do
         if string.sub(key, 1, string.len(ARGV[2])) ~= ARGV[2] then return {-1,'0'} end
       end
       return {math.min(#page[2],tonumber(ARGV[3])),page[1],page[1] ~= '0' and 1 or 0}`,
      1,
      this.marker,
      cursor,
      this.values,
      limit,
    );
    const page = this.page(result);
    if (page.count > limit) unavailable();
    return { found: page.count, nextCursor: page.cursor, hasMore: page.hasMore };
  }
  private page(value: unknown): { count: number; cursor: string; hasMore: boolean } {
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== 'number' ||
      !Number.isSafeInteger(value[0]) ||
      value[0] < 0 ||
      typeof value[1] !== 'string' ||
      !validCursor(value[1]) ||
      (value[2] !== 0 && value[2] !== 1)
    )
      unavailable();
    if (value[1] !== '0' && value[2] !== 1) unavailable();
    return { count: value[0], cursor: value[1], hasMore: value[2] === 1 };
  }
}
