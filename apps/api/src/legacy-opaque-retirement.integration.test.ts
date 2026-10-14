import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  PostgresLegacyOpaqueRetirementAudit,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisLegacyOpaqueStateRetirement,
  RedisOpaqueTokenStore,
} from '@nakh/queue-redis';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(databaseUrl === undefined || redisUrl === undefined)(
  'native authorization with actual legacy Redis retirement',
  () => {
    const redis = createRedisConnection(redisUrl ?? 'redis://invalid');
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(databaseUrl!, 'm8_opaque_cutover');
      await runMigrations(isolated.url, resolve('migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 15000,
      });
    });
    afterAll(async () => {
      await redis.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    function scene(): {
      prefix: string;
      retire: RedisLegacyOpaqueStateRetirement;
      old: RedisOpaqueTokenStore;
      current: RedisOpaqueTokenStore;
    } {
      const prefix = `m8-native-cutover-${randomUUID()}`;
      return {
        prefix,
        retire: new RedisLegacyOpaqueStateRetirement(
          redis,
          prefix,
          new PostgresLegacyOpaqueRetirementAudit(database),
        ),
        old: new RedisOpaqueTokenStore(redis, prefix, 1),
        current: new RedisOpaqueTokenStore(redis, prefix),
      };
    }
    async function drain(retire: RedisLegacyOpaqueStateRetirement): Promise<number> {
      let cursor = '0',
        removed = 0;
      for (let i = 0; i < 10000; i++) {
        const page = await retire.revokeNext(cursor, 100);
        removed += page.removed;
        cursor = page.nextCursor;
        if (!page.hasMore) return removed;
      }
      throw new Error('Cutover did not converge.');
    }
    async function verify(retire: RedisLegacyOpaqueStateRetirement): Promise<boolean> {
      let cursor = '0',
        found = 0;
      for (let i = 0; i < 10000; i++) {
        const page = await retire.verifyNext(cursor);
        found += page.found;
        cursor = page.nextCursor;
        if (!page.hasMore) return found === 0;
      }
      throw new Error('Independent cutover scan did not converge.');
    }
    async function authorizations(namespace: string): Promise<{ id: string }[]> {
      return (
        await sql<{ id: string }>`SELECT id FROM platform.audit_logs
      WHERE event_type='platform.legacy-opaque-retirement-authorized.v1' AND metadata->>'namespaceHash'=${namespace}`.execute(
          database,
        )
      ).rows;
    }
    it('audits twenty concurrent retirement calls and preserves exact 205 removals plus current UI state', async () => {
      const f = scene();
      await Promise.all(
        Array.from({ length: 205 }, (_, i) =>
          f.old.putIfAbsent(
            i.toString(16).padStart(16, '0'),
            'synthetic private encrypted body',
            60,
          ),
        ),
      );
      await f.current.putIfAbsent('abcdefghijklmnop', 'current UI', 60);
      const results = await Promise.all(Array.from({ length: 20 }, () => f.retire.revokeNext()));
      const removed =
        results.reduce((sum, page) => sum + page.removed, 0) + (await drain(f.retire));
      expect(removed).toBe(205);
      expect(await verify(f.retire)).toBe(true);
      expect(await f.current.get('abcdefghijklmnop')).toBe('current UI');
      const audits = await sql<{ authorized: string; observed: string; removed: string }>`SELECT
      (SELECT count(*) FROM platform.audit_logs source WHERE source.event_type='platform.legacy-opaque-retirement-authorized.v1' AND source.metadata->>'namespaceHash'=${f.retire.namespaceHash}) AS authorized,
      count(*) AS observed, coalesce(sum((event.metadata->>'removed')::integer),0) AS removed
      FROM platform.audit_logs event JOIN platform.audit_logs source ON source.id=event.subject_id
      WHERE event.event_type='platform.legacy-opaque-retirement-observed.v1'
        AND source.metadata->>'namespaceHash'=${f.retire.namespaceHash}`.execute(database);
      expect(Number(audits.rows[0]!.authorized)).toBe(Number(audits.rows[0]!.observed));
      expect(Number(audits.rows[0]!.removed)).toBe(205);
      await redis.del(`${f.prefix}:action-v2:abcdefghijklmnop`);
    });
    it('cannot fence or erase cache bodies when native authorization fails', async () => {
      const f = scene();
      await f.old.putIfAbsent('abcdefghijklmnop', 'private body', 60);
      await sql`CREATE FUNCTION platform.m8_cutover_auth_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='platform.legacy-opaque-retirement-authorized.v1' THEN RAISE EXCEPTION 'private synthetic outage'; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER m8_cutover_auth_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.m8_cutover_auth_fault()`.execute(
        database,
      );
      try {
        await expect(f.retire.revokeNext()).rejects.toThrow(
          'Legacy opaque retirement audit is unavailable.',
        );
        expect(await f.old.get('abcdefghijklmnop')).toBe('private body');
        expect(await redis.exists(`${f.prefix}:legacy-action-retired`)).toBe(0);
        expect(await authorizations(f.retire.namespaceHash)).toHaveLength(0);
      } finally {
        await sql`DROP TRIGGER m8_cutover_auth_fault ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION platform.m8_cutover_auth_fault()`.execute(database);
      }
      await drain(f.retire);
    });
    it('retains uncertain native intent after observation loss and requires an actual independent absence scan on recovery', async () => {
      const f = scene();
      await f.old.putIfAbsent('abcdefghijklmnop', 'private body', 60);
      await sql`CREATE FUNCTION platform.m8_cutover_observe_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='platform.legacy-opaque-retirement-observed.v1' THEN RAISE EXCEPTION 'private synthetic outage'; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER m8_cutover_observe_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.m8_cutover_observe_fault()`.execute(
        database,
      );
      try {
        await expect(f.retire.revokeNext()).rejects.toThrow(
          'Legacy opaque retirement audit is unavailable.',
        );
        expect(await f.old.get('abcdefghijklmnop')).toBeUndefined();
        const rows = await authorizations(f.retire.namespaceHash);
        expect(rows).toHaveLength(1);
        expect(
          await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('subject_id', '=', rows[0]!.id)
            .execute(),
        ).toHaveLength(1);
      } finally {
        await sql`DROP TRIGGER m8_cutover_observe_fault ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION platform.m8_cutover_observe_fault()`.execute(database);
      }
      await drain(f.retire);
      expect(await verify(f.retire)).toBe(true);
      // Uncertain intent is retained, never relabelled as an observed deletion or Root completion.
      const pending = await sql<{ count: string }>`SELECT count(*) FROM platform.audit_logs source
      WHERE source.event_type='platform.legacy-opaque-retirement-authorized.v1' AND source.metadata->>'namespaceHash'=${f.retire.namespaceHash}
      AND NOT EXISTS(SELECT 1 FROM platform.audit_logs event WHERE event.subject_id=source.id AND event.event_type='platform.legacy-opaque-retirement-observed.v1')`.execute(
        database,
      );
      expect(Number(pending.rows[0]!.count)).toBe(1);
    });
  },
);
