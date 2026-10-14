import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionMediaObjects, AccountDeletionBatchResult } from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresLegacyOpaqueRetirementAudit,
  PostgresQueueReferenceMigrationAudit,
  PostgresUserSessionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisAccountDeletionEphemeralProvider,
  RedisOwnedOpaqueTokenStore,
} from '@nakh/queue-redis';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';
import { createAccountDeletionRuntime } from './account-deletion-runtime.js';

const dbUrl = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(dbUrl === undefined || redisUrl === undefined)(
  'M8 actual worker native/Redis complete saga',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    const target = new URL(redisUrl ?? 'redis://invalid');
    target.pathname = '/15';
    const redis = createRedisConnection(target.toString()),
      prefixes: string[] = [];
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(dbUrl!, 'm8_worker_saga');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
    });
    beforeEach(async () => {
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
        database,
      );
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
    async function scene(): Promise<{
      item: Awaited<ReturnType<typeof createDeletionFixture>>;
      prefix: string;
      runtime: () => ReturnType<typeof createAccountDeletionRuntime>;
    }> {
      const prefix = `m8-worker-${randomUUID()}`;
      prefixes.push(prefix);
      const item = await createDeletionFixture(database, async (userId) => {
        await new PostgresUserSessionStore(database).issue(
          { userId, productEpoch: 0 },
          randomUUID(),
        );
        await new RedisOwnedOpaqueTokenStore(redis, prefix, {
          userId,
          productEpoch: 0,
        }).putIfAbsent('abcdefghijklmnop', 'PRIVATE OLD BODY', 900);
      });
      const unexpected = (): Promise<never> => {
        return Promise.reject(new Error('No media assets exist in this fixture'));
      };
      const objects: AccountDeletionMediaObjects = {
        list: unexpected,
        get: unexpected,
        putPrivate: unexpected,
        delete: unexpected,
        head: unexpected,
      };
      return {
        item,
        prefix,
        runtime: () =>
          createAccountDeletionRuntime({
            database,
            readers: {},
            objects,
            cache: { purge: unexpected },
            prefix,
            cutoverEvidenceHash: 'a'.repeat(64),
            workerId: randomUUID(),
            environment: 'test',
            ephemeralProvider: new RedisAccountDeletionEphemeralProvider(
              redis,
              prefix,
              new PostgresLegacyOpaqueRetirementAudit(database),
              new PostgresQueueReferenceMigrationAudit(database),
            ),
          }),
      };
    }
    async function completed(f: Awaited<ReturnType<typeof scene>>): Promise<void> {
      expect(
        (
          await sql`SELECT phase,checkpoint_version,reactivation_allowed FROM identity.account_deletion_records WHERE id=${f.item.recordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ phase: 'completed', checkpoint_version: 8, reactivation_allowed: false }]);
      expect(
        (
          await sql`SELECT state,product_epoch FROM identity.accounts WHERE user_id=${f.item.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ state: 'deleted', product_epoch: 0 }]);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${f.item.recordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 7 }]);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM identity.data_retention_records WHERE deletion_record_id=${f.item.recordId}::uuid AND expires_at IS NOT NULL`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        await new RedisOwnedOpaqueTokenStore(redis, f.prefix, {
          userId: f.item.userId,
          productEpoch: 0,
        }).get('abcdefghijklmnop'),
      ).toBeNull();
      const marker = `${f.prefix}:owned-action:{${createHash('sha256').update(f.item.userId).digest('hex')}}:life`;
      expect(await redis.get(marker)).toBe('blocked:0');
      expect(await redis.pttl(marker)).toBe(-1);
    }
    it('composes real sessions, ordinary purge, provider passes, manifest and final completion', async () => {
      const f = await scene(),
        runtime = f.runtime(),
        results: AccountDeletionBatchResult[] = [];
      try {
        for (let n = 0; n < 100; n++) {
          const result = await runtime.execute();
          results.push(result);
          expect(['progress', 'advanced', 'completed']).toContain(result.outcome);
          if (result.outcome === 'completed') break;
        }
      } finally {
        await runtime.close();
      }
      expect(results.at(-1)).toEqual({ outcome: 'completed', phase: 'verification' });
      await completed(f);
    });
    it('serializes twenty competing complete workers into one immutable phase chain', async () => {
      const f = await scene(),
        workers = Array.from({ length: 20 }, () => f.runtime()),
        results: AccountDeletionBatchResult[] = [];
      try {
        for (let n = 0; n < 100; n++) {
          const batch = await Promise.all(workers.map((worker) => worker.execute()));
          results.push(...batch);
          expect(
            batch.every((result) =>
              ['idle', 'progress', 'advanced', 'completed'].includes(result.outcome),
            ),
          ).toBe(true);
          if (batch.some((result) => result.outcome === 'completed')) break;
        }
      } finally {
        await Promise.all(workers.map((worker) => worker.close()));
      }
      expect(results.filter((result) => result.outcome === 'completed')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'advanced')).toHaveLength(6);
      await completed(f);
    });
  },
);
