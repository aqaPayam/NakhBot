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
  PostgresAccountControlSessionStore,
  PostgresAccountReturnStore,
  PostgresAccountReturnActivationAuthority,
  PostgresAccountDeletionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisAccountDeletionEphemeralProvider,
  RedisOwnedOpaqueTokenStore,
  RedisAccountReturnActivation,
} from '@nakh/queue-redis';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';
import { approveAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
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
      grantId: string;
      controlGrantId: string;
      runtime: () => ReturnType<typeof createAccountDeletionRuntime>;
    }> {
      const prefix = `m8-worker-${randomUUID()}`;
      prefixes.push(prefix);
      let grantId = '',
        controlGrantId = '';
      const item = await createDeletionFixture(database, async (userId) => {
        const grant = await new PostgresUserSessionStore(database).issue(
          { userId, productEpoch: 0 },
          randomUUID(),
        );
        expect(grant).toBeDefined();
        grantId = grant!.id;
        const control = await new PostgresAccountControlSessionStore(database).issue(
          { userId, productEpoch: 0 },
          randomUUID(),
        );
        expect(control).toBeDefined();
        controlGrantId = control!.id;
        expect(
          await new RedisOwnedOpaqueTokenStore(redis, prefix, {
            userId,
            productEpoch: 0,
          }).putIfAbsent('abcdefghijklmnop', 'PRIVATE OLD BODY', 900),
        ).toBe(true);
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
        grantId,
        controlGrantId,
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
          await sql`SELECT count(*)::integer AS count FROM identity.data_retention_records WHERE deletion_record_id=${f.item.recordId}::uuid AND retention_expires_at IS NOT NULL`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        await new RedisOwnedOpaqueTokenStore(redis, f.prefix, {
          userId: f.item.userId,
          productEpoch: 0,
        }).get('abcdefghijklmnop'),
      ).toBeUndefined();
      expect(
        (
          await sql`SELECT identity.user_session_authority_revoked(${f.grantId}::uuid) AS revoked`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ revoked: true }]);
      expect(
        await new PostgresAccountControlSessionStore(database).current(
          { userId: f.item.userId, productEpoch: 0 },
          f.controlGrantId,
        ),
      ).toBeDefined();
      expect(
        await new PostgresUserSessionStore(database).current(
          { userId: f.item.userId, productEpoch: 0 },
          f.controlGrantId,
        ),
      ).toBeUndefined();
      const scope = `${f.prefix}:owned-action:{${createHash('sha256').update(f.item.userId).digest('hex')}}`;
      const valueKey = `${scope}:0:value:${createHash('sha256').update('public:abcdefghijklmnop').digest('hex')}`;
      expect(await redis.get(valueKey)).toBeNull();
      const marker = `${f.prefix}:owned-action:{${createHash('sha256').update(f.item.userId).digest('hex')}}:life`;
      expect(await redis.get(marker)).toBe('blocked:0');
      expect(await redis.pttl(marker)).toBe(-1);
    }
    async function runComplete(f: Awaited<ReturnType<typeof scene>>): Promise<void> {
      const runtime = f.runtime();
      let outcome = '';
      try {
        for (let n = 0; n < 100; n++) {
          const result = await runtime.execute();
          expect(['progress', 'advanced', 'completed']).toContain(result.outcome);
          outcome = result.outcome;
          if (outcome === 'completed') break;
        }
      } finally {
        await runtime.close();
      }
      expect(outcome).toBe('completed');
    }
    async function returnLife(f: Awaited<ReturnType<typeof scene>>, epoch: number): Promise<void> {
      const root = (
        await sql<{
          id: string;
          account_version: number;
        }>`SELECT id,account_version FROM identity.account_deletion_records WHERE user_id=${f.item.userId}::uuid AND product_epoch=${epoch}`.execute(
          database,
        )
      ).rows[0]!;
      await approveAccountReturnFixture(database, {
        recordId: root.id,
        version: root.account_version,
      });
      const grant = await new PostgresAccountControlSessionStore(database).issue(
        { userId: f.item.userId, productEpoch: epoch },
        randomUUID(),
      );
      const id = randomUUID();
      await new PostgresAccountReturnStore(database, {
        kind: 'user',
        scope: 'account_control',
        userId: f.item.userId,
        productEpoch: epoch,
        controlGrantId: grant!.id,
      }).return({
        commandId: id,
        commandType: 'account.return',
        schemaVersion: 1,
        actor: { kind: 'user', userId: f.item.userId },
        requestId: randomUUID(),
        idempotencyKey: id,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: root.account_version },
      });
    }
    it('activates actual approved Return after real provider cleanup and recovers a lost Redis acknowledgment under twenty retries', async () => {
      const f = await scene();
      await runComplete(f);
      await completed(f);
      await returnLife(f, 0);
      const authority = new PostgresAccountReturnActivationAuthority(database),
        life = { userId: f.item.userId, productEpoch: 1 };
      const before = (
        await sql`SELECT to_jsonb(a) AS proof FROM platform.audit_logs a WHERE event_type='account.returned.v1' AND subject_id=${f.item.recordId}::uuid`.execute(
          database,
        )
      ).rows;
      const failAfter = new RedisAccountReturnActivation(
        {
          eval: async (script, count, ...args) => {
            await redis.eval(script, count, ...args);
            throw new Error('private acknowledgment loss');
          },
        },
        f.prefix,
        authority,
      );
      await expect(failAfter.activate(life)).rejects.toThrow(
        'Opaque state activation is unavailable.',
      );
      const fresh = new RedisOwnedOpaqueTokenStore(redis, f.prefix, life),
        old = new RedisOwnedOpaqueTokenStore(redis, f.prefix, {
          userId: life.userId,
          productEpoch: 0,
        });
      await fresh.putIfAbsent('abcdefghijklmnop', 'FRESH LIFE BODY', 900);
      const activate = new RedisAccountReturnActivation(redis, f.prefix, authority);
      await Promise.all(Array.from({ length: 20 }, () => activate.activate(life)));
      await expect(old.putIfAbsent('oldoldoldoldold1', 'OLD DELAYED BODY', 900)).rejects.toThrow(
        'unavailable',
      );
      await expect(old.revokeNext()).rejects.toThrow('unavailable');
      expect(await old.get('abcdefghijklmnop')).toBeUndefined();
      expect(await fresh.get('abcdefghijklmnop')).toBe('FRESH LIFE BODY');
      await expect(
        new RedisAccountReturnActivation(redis, `${f.prefix}-foreign`, authority).activate(life),
      ).rejects.toThrow('unavailable');
      expect(
        (
          await sql`SELECT to_jsonb(a) AS proof FROM platform.audit_logs a WHERE event_type='account.returned.v1' AND subject_id=${f.item.recordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await sql`SELECT balance,product_epoch FROM billing.credit_accounts WHERE user_id=${life.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ balance: '0', product_epoch: 1 }]);
    });
    it('fences a timed-out late activation through actual next-life deletion and a second independently approved Return', async () => {
      const f = await scene();
      await runComplete(f);
      await returnLife(f, 0);
      const authority = new PostgresAccountReturnActivationAuthority(database),
        life = { userId: f.item.userId, productEpoch: 1 };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let queued: Promise<unknown> | undefined;
      const delayed = new RedisAccountReturnActivation(
        {
          eval: (script, count, ...args) => {
            queued = gate.then(() => redis.eval(script, count, ...args));
            return Promise.reject(new Error('private timed-out request'));
          },
        },
        f.prefix,
        authority,
      );
      await expect(delayed.activate(life)).rejects.toThrow(
        'Opaque state activation is unavailable.',
      );
      try {
        const grant = await new PostgresAccountControlSessionStore(database).issue(
          life,
          randomUUID(),
        );
        const deletion = new PostgresAccountDeletionStore(
          database,
          { activeKeyId: 'worker-return', keys: new Map([['worker-return', Buffer.alloc(32, 8)]]) },
          { kind: 'user', scope: 'account_control', ...life, controlGrantId: grant!.id },
        );
        const version = (
          await database
            .selectFrom('identity.accounts')
            .select('version')
            .where('user_id', '=', life.userId)
            .executeTakeFirstOrThrow()
        ).version;
        const proof = await deletion.prepare({
            actor: { kind: 'user', userId: life.userId },
            requestId: randomUUID(),
            expectedAccountVersion: version,
          }),
          id = randomUUID();
        await deletion.request({
          commandId: id,
          commandType: 'account.delete',
          schemaVersion: 1,
          actor: { kind: 'user', userId: life.userId },
          requestId: randomUUID(),
          idempotencyKey: id,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { expectedAccountVersion: version, confirmationToken: proof.confirmationToken },
        });
        await runComplete(f);
        const marker = `${f.prefix}:owned-action:{${createHash('sha256').update(life.userId).digest('hex')}}:life`;
        expect(await redis.get(marker)).toBe('blocked:1');
        release();
        expect(await queued).toBe(-1);
        await expect(
          new RedisAccountReturnActivation(redis, f.prefix, authority).activate(life),
        ).rejects.toThrow('unavailable');
        await returnLife(f, 1);
        const current = { userId: life.userId, productEpoch: 2 };
        await new RedisAccountReturnActivation(redis, f.prefix, authority).activate(current);
        const fresh = new RedisOwnedOpaqueTokenStore(redis, f.prefix, current),
          old = new RedisOwnedOpaqueTokenStore(redis, f.prefix, life);
        await fresh.putIfAbsent('abcdefghijklmnop', 'SECOND FRESH BODY', 900);
        await expect(old.revokeNext()).rejects.toThrow('unavailable');
        await expect(old.putIfAbsent('oldoldoldoldold1', 'OLD LIFE ONE', 900)).rejects.toThrow(
          'unavailable',
        );
        expect(await fresh.get('abcdefghijklmnop')).toBe('SECOND FRESH BODY');
        expect(
          (
            await sql`SELECT identity.account_return_completed(${f.item.recordId}::uuid) AS original,billing.deletion_credit_cutover_valid(${f.item.recordId}::uuid) AS financial`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ original: true, financial: true }]);
      } finally {
        release();
        await queued;
      }
    });
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
