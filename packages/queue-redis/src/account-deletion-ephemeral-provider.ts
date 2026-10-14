import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  AccountDeletionEphemeralProvider,
  DeletionEphemeralOperation,
  DeletionEphemeralObservation,
  LegacyOpaqueRetirementAudit,
} from '@nakh/application';
import {
  RedisOwnedOpaqueTokenStore,
  RedisLegacyOpaqueStateRetirement,
  BullMqLegacyReferenceMigration,
  type QueueReferenceMigrationAudit,
  type QueuedEventReference,
  type QueueReferenceMigrationCursor,
} from './index.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const numeric = /^(0|[1-9][0-9]{0,19})$/u;
const safeFailure = new Set([
  'invalid_queued_event',
  'invalid_queued_event_reference',
  'domain_event_processing_failed',
  'job stalled more than allowable limit',
]);
function unavailable(): never {
  throw new Error('Ephemeral provider verification is unavailable.');
}
function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function safeOptions(value: unknown, id: string): boolean {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (key === 'jobId') return item === id;
    if (['attempts', 'delay', 'priority', 'timestamp', 'stackTraceLimit', 'keepLogs'].includes(key))
      return integer(item);
    if (key === 'lifo') return typeof item === 'boolean';
    if (key === 'backoff')
      return (
        object(item) &&
        Object.keys(item).sort().join(',') === 'delay,type' &&
        ['exponential', 'fixed'].includes(String(item.type)) &&
        integer(item.delay)
      );
    if (key === 'removeOnComplete' || key === 'removeOnFail')
      return (
        typeof item === 'boolean' ||
        integer(item) ||
        (object(item) &&
          Object.keys(item).length > 0 &&
          Object.entries(item).every(
            ([field, n]) => ['age', 'count'].includes(field) && integer(n),
          ))
      );
    return false;
  });
}
function safeDiagnostics(row: Readonly<Record<string, string>>): boolean {
  if (
    row.failedReason !== undefined &&
    row.failedReason !== '' &&
    !safeFailure.has(row.failedReason)
  )
    return false;
  if (row.returnvalue !== undefined && !['null', 'undefined', ''].includes(row.returnvalue))
    return false;
  if (row.progress !== undefined && row.progress !== '0') return false;
  if (row.stacktrace !== undefined) {
    let traces: unknown;
    try {
      traces = JSON.parse(row.stacktrace);
    } catch {
      return false;
    }
    if (traces !== null && (!Array.isArray(traces) || traces.length !== 0)) return false;
  }
  return true;
}
function queueKeys(value: unknown, prefix: string): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(
      (key: unknown) =>
        typeof key === 'string' && key.startsWith(prefix) && key.length <= prefix.length + 100,
    )
  );
}
/** Trusted native operation authorizes a global transport cutover, not inferred
 * ownership of old encrypted bodies. SCAN COUNT is advisory; actual resource and
 * event-history mutation batches are bounded. Unknown queue families fail closed. */
export class RedisAccountDeletionEphemeralProvider implements AccountDeletionEphemeralProvider {
  public readonly namespaceHash: string;
  private readonly legacy: RedisLegacyOpaqueStateRetirement;
  private readonly migration: BullMqLegacyReferenceMigration;
  private readonly jobs: string;
  private readonly eventFence: string;
  public constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    legacyAudit: LegacyOpaqueRetirementAudit,
    private readonly queueAudit: QueueReferenceMigrationAudit & {
      verifyReference(reference: QueuedEventReference): Promise<void>;
    },
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(prefix)) unavailable();
    this.namespaceHash = createHash('sha256').update(`m8-ephemeral-v1\0${prefix}`).digest('hex');
    this.jobs = `${prefix}:domain-events:`;
    this.eventFence = `${prefix}:m8-queue-event-cutover`;
    this.legacy = new RedisLegacyOpaqueStateRetirement(redis, prefix, legacyAudit);
    this.migration = new BullMqLegacyReferenceMigration(redis, prefix, queueAudit);
  }
  public async execute(
    op: DeletionEphemeralOperation,
    assertCurrent: () => Promise<void>,
  ): Promise<DeletionEphemeralObservation> {
    if (op.namespaceHash !== this.namespaceHash || !/^[0-9a-f]{64}$/u.test(op.cutoverEvidenceHash))
      unavailable();
    await assertCurrent();
    if (op.stage === 'owned_remove' || op.stage === 'owned_verify') {
      if (typeof op.cursor !== 'string') unavailable();
      const owned = new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, {
        userId: op.userId,
        productEpoch: op.productEpoch,
      });
      if (op.stage === 'owned_remove') {
        const page = await owned.revokeNext(100, op.cursor);
        return { cursor: page.nextCursor, more: page.hasMore, found: 0 };
      }
      const marker = `${this.prefix}:owned-action:{${createHash('sha256').update(op.userId.toLowerCase()).digest('hex')}}:life`;
      if (
        (await this.redis.get(marker)) !== `blocked:${op.productEpoch}` ||
        (await this.redis.pttl(marker)) !== -1
      )
        return { cursor: '0', more: false, found: 1 };
      const page = await owned.verifyNext(op.cursor);
      return { cursor: page.nextCursor, more: page.hasMore, found: page.found };
    }
    if (op.stage === 'legacy_remove' || op.stage === 'legacy_verify') {
      if (typeof op.cursor !== 'string') unavailable();
      if (op.stage === 'legacy_remove') {
        const page = await this.legacy.revokeNext(op.cursor);
        return { cursor: page.nextCursor, more: page.hasMore, found: 0 };
      }
      if (
        (await this.redis.get(`${this.prefix}:legacy-action-retired`)) !== 'retired-v1' ||
        (await this.redis.pttl(`${this.prefix}:legacy-action-retired`)) !== -1
      )
        return { cursor: '0', more: false, found: 1 };
      const page = await this.legacy.verifyNext(op.cursor);
      return { cursor: page.nextCursor, more: page.hasMore, found: page.found };
    }
    if (op.stage !== 'queue_normalize' && op.stage !== 'queue_verify') unavailable();
    if (typeof op.cursor === 'string') unavailable();
    if (op.stage === 'queue_verify') {
      const marker = await this.redis.get(this.eventFence);
      if (
        marker === null ||
        !/^[0-9]+-[0-9]+$/u.test(marker) ||
        (await this.redis.pttl(this.eventFence)) !== -1
      )
        return { cursor: { redisCursor: '0', pendingKeys: [] }, more: false, found: 1 };
    }
    return this.queuePage(op.cursor, op.stage === 'queue_verify', assertCurrent);
  }
  private async stream(verify: boolean): Promise<boolean> {
    const result = await this.redis.eval(
      `
      local fence=redis.call('GET',KEYS[2])
      if not fence then
        if ARGV[1] == 'verify' then return -1 end
        local tail=redis.call('XREVRANGE',KEYS[1],'+','-','COUNT',1)
        fence=#tail>0 and tail[1][1] or '0-0'
        redis.call('SET',KEYS[2],fence)
      end
      if not string.match(fence,'^%d+%-%d+$') then return -1 end
      if redis.call('PTTL',KEYS[2]) ~= -1 then if ARGV[1]=='verify' then return -1 end redis.call('PERSIST',KEYS[2]) end
      if redis.call('XLEN',KEYS[1]) > 100000 then return -1 end
      local removed=0
      local old=redis.call('XRANGE',KEYS[1],'-',fence,'COUNT',100)
      if ARGV[1]~='verify' then
        for _,entry in ipairs(old) do redis.call('XDEL',KEYS[1],entry[1]) removed=removed+1 end
      end
      local found=#redis.call('XRANGE',KEYS[1],'-',fence,'COUNT',1)>0
      local states={waiting=true,active=true,completed=true,failed=true,delayed=true,paused=true,['waiting-children']=true}
      local events={added=true,waiting=true,active=true,completed=true,failed=true,progress=true,delayed=true,stalled=true,removed=true,['waiting-children']=true,drained=true,paused=true,resumed=true,['retries-exhausted']=true,duplicated=true,debounced=true,deduplicated=true,cleaned=true}
      local failures={invalid_queued_event=true,invalid_queued_event_reference=true,domain_event_processing_failed=true,['job stalled more than allowable limit']=true}
      -- Atomic finite verification cannot lose an entry to list-index shifts.
      -- No field values leave Redis. Unknown event content is ordinary transport,
      -- never canonical money/security evidence; remove at most 100 entries.
      for _,entry in ipairs(redis.call('XRANGE',KEYS[1],'-','+','COUNT',100000)) do
        local safe=true
        for i=1,#entry[2],2 do
          local field=entry[2][i] local value=entry[2][i+1]
          if field=='event' then if not events[value] then safe=false end
          elseif field=='jobId' then if not string.match(value,'^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') then safe=false end
          elseif field=='name' then if #value>160 or not string.match(value,'^[a-z][a-z0-9_.%-]*$') then safe=false end
          elseif field=='prev' then if not states[value] then safe=false end
          elseif field=='failedReason' then if not failures[value] then safe=false end
          elseif field=='returnvalue' or field=='data' then if value~='null' and value~='0' and value~='' then safe=false end
          elseif field=='delay' or field=='ts' or field=='count' or field=='attemptsMade' then if not string.match(value,'^%d+$') or #value>20 then safe=false end
          else safe=false end
        end
        if not safe then
          if ARGV[1]~='verify' and removed<100 then redis.call('XDEL',KEYS[1],entry[1]) removed=removed+1 else found=true end
        end
      end
      return found and 1 or 0
    `,
      2,
      `${this.jobs}events`,
      this.eventFence,
      verify ? 'verify' : 'remove',
    );
    if (result !== 0 && result !== 1) unavailable();
    return result === 1;
  }
  private async queuePage(
    cursor: QueueReferenceMigrationCursor,
    verify: boolean,
    guard: () => Promise<void>,
  ): Promise<DeletionEphemeralObservation> {
    const saved: unknown = cursor.pendingKeys;
    if (
      !numeric.test(cursor.redisCursor) ||
      BigInt(cursor.redisCursor) > 18446744073709551615n ||
      !queueKeys(saved, this.jobs)
    )
      unavailable();
    await guard();
    const streamPending = await this.stream(verify);
    const page: [string, string[]] =
      saved.length > 0
        ? [cursor.redisCursor, [...saved]]
        : await this.redis.scan(cursor.redisCursor, 'MATCH', `${this.jobs}*`, 'COUNT', 100);
    if (page[1].length > 1000 || !numeric.test(page[0]) || BigInt(page[0]) > 18446744073709551615n)
      unavailable();
    let found = streamPending ? 1 : 0;
    const keys = page[1].slice(0, 99);
    for (const key of keys) {
      if (!key.startsWith(this.jobs) || key.length > this.jobs.length + 100) unavailable();
      await guard();
      const suffix = key.slice(this.jobs.length),
        type = await this.redis.type(key);
      if (type === 'none') continue;
      if (suffix === 'events') {
        if (type !== 'stream') unavailable();
        continue;
      }
      if (uuid.test(suffix)) {
        if (
          type !== 'hash' ||
          (await this.redis.hlen(key)) > 64 ||
          (await this.redis.hstrlen(key, 'data')) > 131072
        )
          unavailable();
        if (!verify) {
          const migrated = await this.migration.scanNext(
            { redisCursor: '0', pendingKeys: [key] },
            1,
          );
          if (migrated.active > 0 || migrated.changed > 0) {
            found++;
            continue;
          }
        }
        const row = await this.redis.hgetall(key);
        if (Object.keys(row).length === 0) continue;
        let data: unknown;
        try {
          data = JSON.parse(row.data ?? 'null');
        } catch {
          unavailable();
        }
        if (
          !object(data) ||
          Object.keys(data).sort().join(',') !==
            'aggregateId,aggregateType,eventId,eventSchemaVersion,eventType,kind' ||
          data.kind !== 'outbox-reference.v1' ||
          data.eventId !== suffix ||
          data.eventType !== row.name ||
          typeof data.eventType !== 'string' ||
          !/^[a-z][a-z0-9_.-]{0,159}$/u.test(data.eventType) ||
          typeof data.aggregateId !== 'string' ||
          !uuid.test(data.aggregateId) ||
          typeof data.aggregateType !== 'string' ||
          !/^[a-z][a-z0-9_.-]{0,79}$/u.test(data.aggregateType) ||
          !integer(data.eventSchemaVersion) ||
          (data.eventSchemaVersion as number) < 1
        ) {
          found++;
          continue;
        }
        const diagnostics = new Set(['failedReason', 'stacktrace', 'returnvalue', 'progress']);
        let safe = true;
        for (const [field, value] of Object.entries(row)) {
          if (['data', 'name'].includes(field) || diagnostics.has(field)) continue;
          if (field === 'opts') {
            let opts: unknown;
            try {
              opts = JSON.parse(value);
            } catch {
              safe = false;
              continue;
            }
            if (!safeOptions(opts, suffix)) safe = false;
            continue;
          }
          if (field === 'id') {
            if (value !== suffix) safe = false;
            continue;
          }
          if (
            [
              'timestamp',
              'delay',
              'priority',
              'processedOn',
              'finishedOn',
              'atm',
              'ats',
              'stc',
            ].includes(field)
          ) {
            if (!numeric.test(value)) safe = false;
            continue;
          }
          if (field === 'pb') {
            if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)) safe = false;
            continue;
          }
          safe = false;
        }
        if (!safe) {
          found++;
          continue;
        }
        if (verify) {
          await this.queueAudit.verifyReference(data as QueuedEventReference);
          if (!safeDiagnostics(row)) found++;
          continue;
        }
        await guard();
        const result = await this.redis.eval(
          `
          if redis.call('EXISTS',KEYS[2]) == 1 then return 1 end
          if redis.call('HGET',KEYS[1],'data') ~= ARGV[1] then return 1 end
          redis.call('HDEL',KEYS[1],'failedReason','stacktrace','returnvalue','progress')
          return 0
        `,
          2,
          key,
          `${key}:lock`,
          row.data!,
        );
        if (result !== 0 && result !== 1) unavailable();
        found += result;
        continue;
      }
      if (suffix.endsWith(':logs') && uuid.test(suffix.slice(0, -5))) {
        if (type !== 'list') unavailable();
        if (verify) {
          if ((await this.redis.llen(key)) > 0) found++;
        } else {
          await guard();
          const result = await this.redis.eval(
            `if redis.call('EXISTS',KEYS[2]) == 1 then return 1 end redis.call('DEL',KEYS[1]) return 0`,
            2,
            key,
            `${this.jobs}${suffix.slice(0, -5)}:lock`,
          );
          if (result !== 0 && result !== 1) unavailable();
          found += result;
        }
        continue;
      }
      if (suffix.endsWith(':lock') && uuid.test(suffix.slice(0, -5))) {
        if (type !== 'string' || (await this.redis.strlen(key)) > 128) unavailable();
        continue;
      }
      if (['id', 'stalled-check', 'limiter'].includes(suffix)) {
        if (type !== 'string' || !numeric.test((await this.redis.get(key)) ?? '')) unavailable();
        continue;
      }
      if (suffix === 'meta') {
        if (type !== 'hash' || (await this.redis.hlen(key)) > 10) unavailable();
        for (const [field, value] of Object.entries(await this.redis.hgetall(key)))
          if (
            field === 'version'
              ? !/^bullmq:[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)
              : !['opts.maxLenEvents', 'concurrency', 'paused', 'max', 'duration'].includes(
                  field,
                ) || !numeric.test(value)
          )
            unavailable();
        continue;
      }
      if (
        [
          'wait',
          'paused',
          'active',
          'delayed',
          'prioritized',
          'completed',
          'failed',
          'stalled',
          'waiting-children',
          'marker',
        ].includes(suffix)
      ) {
        if (!['list', 'set', 'zset'].includes(type)) unavailable();
        // Control collections contain IDs only. The fixed ceiling bounds the
        // atomic read and prevents index shifts from skipping a corrupt member.
        const valid = await this.redis.eval(
          `
          local kind=ARGV[1]
          local count=kind=='list' and redis.call('LLEN',KEYS[1]) or (kind=='set' and redis.call('SCARD',KEYS[1]) or redis.call('ZCARD',KEYS[1]))
          if count>100000 then return -1 end
          local values=kind=='list' and redis.call('LRANGE',KEYS[1],0,-1) or (kind=='set' and redis.call('SMEMBERS',KEYS[1]) or redis.call('ZRANGE',KEYS[1],0,-1))
          for _,value in ipairs(values) do
            if ARGV[2]=='marker' then if value~='0' and value~='1' then return 0 end
            elseif not string.match(value,'^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') then return 0 end
          end
          return 1
        `,
          1,
          key,
          type,
          suffix,
        );
        if (valid === -1) unavailable();
        if (valid !== 0 && valid !== 1) unavailable();
        if (valid === 0) found++;
        continue;
      }
      unavailable();
    }
    const pending = page[1].slice(keys.length);
    if (streamPending && !verify && !pending.includes(`${this.jobs}events`))
      pending.push(`${this.jobs}events`);
    if (pending.length > 1000) unavailable();
    const next = { redisCursor: page[0], pendingKeys: pending };
    return { cursor: next, more: next.redisCursor !== '0' || pending.length > 0, found };
  }
}
