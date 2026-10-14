import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecuteAccountDeletionEphemeral,
  type AccountDeletionLease,
  type AccountDeletionEphemeralProvider,
} from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresAccountDeletionEphemeralStore,
  PostgresAccountDeletionSessionStore,
  PostgresAccountDeletionWorkStore,
  PostgresAccountDeletionRetentionStore,
  PostgresUserSessionStore,
  PostgresQueueReferenceMigrationAudit,
  PostgresLegacyOpaqueRetirementAudit,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisAccountDeletionEphemeralProvider,
  RedisOwnedOpaqueTokenStore,
  RedisOpaqueTokenStore,
} from '@nakh/queue-redis';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createEphemeralDeletionFixture } from '../../../packages/persistence-postgres/src/testing/ephemeral-deletion-fixture.js';
const dbUrl = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(dbUrl === undefined || redisUrl === undefined)(
  'M8 actual native/Redis whole ephemeral checkpoint',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    // Dedicated real Redis logical database isolates this composed lifecycle's
    // fixtures from the other CI shard. No fake Redis or FLUSHDB is used.
    const target = new URL(redisUrl ?? 'redis://invalid');
    target.pathname = '/15';
    const redis = createRedisConnection(target.toString()),
      prefixes: string[] = [];
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(dbUrl!, 'm8_ephemeral_composed');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
    });
    afterAll(async () => {
      for (const prefix of prefixes) {
        let cursor = '0';
        do {
          const page = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
          cursor = page[0];
          for (let n = 0; n < page[1].length; n += 100)
            await redis.del(...page[1].slice(n, n + 100));
        } while (cursor !== '0');
      }
      await redis.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    beforeEach(async () => {
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
        database,
      );
    });
    async function scene(count = 3): Promise<{
      prefix: string;
      lease: AccountDeletionLease;
      store: PostgresAccountDeletionEphemeralStore;
      provider: RedisAccountDeletionEphemeralProvider;
      work: PostgresAccountDeletionWorkStore;
      counterpart: RedisOwnedOpaqueTokenStore;
      grantId: string;
    }> {
      const prefix = `m8-composed-${randomUUID()}`;
      prefixes.push(prefix);
      let grantId = '';
      const item = await createEphemeralDeletionFixture(database, async (userId) => {
        grantId = (await new PostgresUserSessionStore(database).issue(
          { userId, productEpoch: 0 },
          randomUUID(),
        ))!.id;
        const owner = new RedisOwnedOpaqueTokenStore(redis, prefix, { userId, productEpoch: 0 }),
          old = new RedisOpaqueTokenStore(redis, prefix, 1);
        for (let n = 0; n < count; n++) {
          const id = n.toString(16).padStart(16, '0');
          await owner.putIfAbsent(id, 'PRIVATE OWNED BODY', 900);
          await old.putIfAbsent(id, 'PRIVATE LEGACY BODY', 900);
        }
        const scope = `${prefix}:owned-action:{${createHash('sha256').update(userId).digest('hex')}}`;
        await redis.set(`${scope}:0:value:orphan`, 'PRIVATE UNINDEXED BODY');
      });
      const counterpart = new RedisOwnedOpaqueTokenStore(redis, prefix, {
        userId: randomUUID(),
        productEpoch: 0,
      });
      await counterpart.putIfAbsent('abcdefghijklmnop', 'COUNTERPART BODY', 900);
      await new RedisOpaqueTokenStore(redis, prefix).putIfAbsent(
        'abcdefghijklmnop',
        'CURRENT ADMIN UI',
        900,
      );
      const event = await database
        .selectFrom('platform.outbox_events')
        .selectAll()
        .where('aggregate_id', '=', item.recordId)
        .where('event_type', '=', 'account.deletion-requested.v1')
        .executeTakeFirstOrThrow();
      const body = {
        id: event.id,
        eventType: event.event_type,
        schemaVersion: event.schema_version,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        payload: event.payload,
        occurredAt: event.occurred_at.toISOString(),
        correlationId: event.correlation_id,
        causationId: event.causation_id,
      };
      const key = `${prefix}:domain-events:${event.id}`;
      await redis.hset(key, {
        name: body.eventType,
        data: JSON.stringify(body),
        failedReason: 'PRIVATE FAILED CLONE',
        stacktrace: JSON.stringify(['PRIVATE STACK CLONE']),
      });
      await redis.rpush(`${key}:logs`, 'PRIVATE LOG CLONE');
      await redis.xadd(
        `${prefix}:domain-events:events`,
        '*',
        'event',
        'failed',
        'jobId',
        event.id,
        'failedReason',
        'PRIVATE STREAM CLONE',
      );
      const store = new PostgresAccountDeletionEphemeralStore(database, prefix, 'a'.repeat(64));
      const provider = new RedisAccountDeletionEphemeralProvider(
        redis,
        prefix,
        new PostgresLegacyOpaqueRetirementAudit(database),
        new PostgresQueueReferenceMigrationAudit(database),
      );
      return {
        prefix,
        lease: item.lease,
        store,
        provider,
        work: new PostgresAccountDeletionWorkStore(database),
        counterpart,
        grantId,
      };
    }
    async function run(
      f: Awaited<ReturnType<typeof scene>>,
      provider: AccountDeletionEphemeralProvider = f.provider,
    ): Promise<void> {
      const executor = new ExecuteAccountDeletionEphemeral(
        f.store,
        new PostgresAccountDeletionSessionStore(database),
        provider,
      );
      for (let n = 0; n < 2000; n++) {
        const result = await executor.executeNext(f.lease);
        if (result.completed) return;
        await f.work.release(f.lease);
        f.lease = (
          await f.work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 })
        )[0]!;
      }
      throw new Error('Composed cleanup did not converge.');
    }
    it('commits phase six only after real bounded body cleanup and all independent physical passes', async () => {
      const f = await scene(205),
        moneyBefore = (
          await sql`SELECT to_jsonb(account) AS row FROM billing.credit_accounts account WHERE user_id=${f.lease.userId}::uuid`.execute(
            database,
          )
        ).rows;
      await run(f);
      expect(
        (
          await sql`SELECT phase,checkpoint_version,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${f.lease.deletionRecordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([
        {
          phase: 'retention_manifest',
          checkpoint_version: 6,
          completed_at: null,
          reactivation_allowed: false,
        },
      ]);
      expect(
        (
          await sql<{
            revoked: boolean;
          }>`SELECT identity.user_session_authority_revoked(${f.grantId}::uuid) AS revoked`.execute(
            database,
          )
        ).rows[0]!.revoked,
      ).toBe(true);
      expect(await f.counterpart.get('abcdefghijklmnop')).toBe('COUNTERPART BODY');
      expect(await new RedisOpaqueTokenStore(redis, f.prefix).get('abcdefghijklmnop')).toBe(
        'CURRENT ADMIN UI',
      );
      const scope = `${f.prefix}:owned-action:{${createHash('sha256').update(f.lease.userId).digest('hex')}}`;
      expect(await redis.keys(`${scope}:0:value:*`)).toEqual([]);
      expect(await redis.keys(`${f.prefix}:action:*`)).toEqual([]);
      expect(await redis.pttl(`${scope}:life`)).toBe(-1);
      expect(
        (
          await sql`SELECT to_jsonb(account) AS row FROM billing.credit_accounts account WHERE user_id=${f.lease.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual(moneyBefore);
      const audits = (
        await sql`SELECT metadata FROM platform.audit_logs WHERE subject_id=${f.lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows;
      expect(JSON.stringify(audits)).not.toContain('PRIVATE');
    });
    it('composes real Redis cleanup, retention inventory and a fresh final cycle without enabling Return', async () => {
      const f = await scene();
      await run(f);
      f.lease = (await f.work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      expect(f.lease.phase).toBe('retention_manifest');
      const retention = new PostgresAccountDeletionRetentionStore(database);
      for (let n = 0; n < 20; n++) if (!(await retention.recordNext(f.lease)).hasMore) break;
      expect(await retention.finish(f.lease)).toEqual({ completed: true });
      f.lease = (await f.work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      expect(f.lease.phase).toBe('verification');
      expect(await f.store.finish(f.lease)).toEqual({ completed: false });
      const scope = `${f.prefix}:owned-action:{${createHash('sha256').update(f.lease.userId).digest('hex')}}`;
      await redis.set(`${scope}:0:value:late-orphan`, 'PRIVATE LATE BODY');
      await run(f);
      expect(await redis.get(`${scope}:0:value:late-orphan`)).toBeNull();
      expect(await f.counterpart.get('abcdefghijklmnop')).toBe('COUNTERPART BODY');
      expect(
        (
          await sql`SELECT phase,checkpoint_version,reactivation_allowed FROM identity.account_deletion_records WHERE id=${f.lease.deletionRecordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ phase: 'completed', checkpoint_version: 8, reactivation_allowed: false }]);
      expect(
        (
          await sql`SELECT state,product_epoch FROM identity.accounts WHERE user_id=${f.lease.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ state: 'deleted', product_epoch: 0 }]);
    });
    it('recovers an actual provider effect followed by transport loss without inventing an observation', async () => {
      const f = await scene();
      let fail = true;
      const provider: AccountDeletionEphemeralProvider = {
        namespaceHash: f.provider.namespaceHash,
        execute: async (op, guard) => {
          const result = await f.provider.execute(op, guard);
          if (fail && op.stage === 'owned_remove') {
            fail = false;
            throw new Error('provider response lost');
          }
          return result;
        },
      };
      await expect(run(f, provider)).rejects.toThrow('provider response lost');
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::integer AS count FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=${f.lease.deletionRecordId}::uuid`.execute(
            database,
          )
        ).rows[0]!.count,
      ).toBe(0);
      await f.work.release(f.lease);
      f.lease = (await f.work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      await run(f);
      const receipt = (
        await sql<{
          metadata: Record<string, unknown>;
        }>`SELECT metadata FROM platform.audit_logs WHERE event_type='account.deletion-ephemeral-reverified.v1' AND subject_id=${f.lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      const pages = (
        await sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=${f.lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows[0]!.count;
      expect(Number(receipt.metadata.reverifiedIntentCount)).toBeGreaterThan(pages);
      expect(receipt.metadata).not.toHaveProperty('removed');
    });
    it('restarts cleanup after a real expiring owned fence and reaches completion only with restored independent proof', async () => {
      const f = await scene();
      let damage = true;
      const provider: AccountDeletionEphemeralProvider = {
        namespaceHash: f.provider.namespaceHash,
        execute: async (op, guard) => {
          if (damage && op.stage === 'owned_verify') {
            damage = false;
            await redis.expire(
              `${f.prefix}:owned-action:{${createHash('sha256').update(op.userId).digest('hex')}}:life`,
              30,
            );
          }
          return f.provider.execute(op, guard);
        },
      };
      await run(f, provider);
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::integer AS count FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=${f.lease.deletionRecordId}::uuid AND stage=0`.execute(
            database,
          )
        ).rows[0]!.count,
      ).toBeGreaterThanOrEqual(2);
      expect(await f.counterpart.get('abcdefghijklmnop')).toBe('COUNTERPART BODY');
    });
  },
);
