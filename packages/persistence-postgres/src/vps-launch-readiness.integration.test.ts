import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConfig, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import {
  readVpsLaunchReadiness,
  type VpsReadinessBinding,
  type VpsMachineIdentity,
} from './vps-launch-readiness.js';

const source = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(source === undefined)(
  'private VPS readiness with native database authority',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let database: NakhDatabase;
    let binding: VpsReadinessBinding;
    let secret: { NAKH_DATABASE_URL: string };
    // Synthetic host/TLS fixtures qualify native database behavior, not the actual VPS or TLS.
    const host = (): Promise<VpsMachineIdentity> =>
      Promise.resolve({ platform: 'linux', uid: 0, machineId: binding.machineId });
    const connect = (config: DatabaseConfig): NakhDatabase =>
      createDatabase({ ...config, url: isolated.url });
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(source!, 'nakh_vps_readiness');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 2,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const url = new URL(isolated.url);
      binding = {
        version: 1,
        environment: 'staging',
        sourceSha: 'a'.repeat(40),
        telegramBotId: '123456789',
        machineId: 'b'.repeat(32),
        databaseHost: 'reviewed.vps.invalid',
        databaseName: decodeURIComponent(url.pathname.slice(1)),
        databaseUser: decodeURIComponent(url.username),
        databaseSecretPath: '/run/nakh-operator/database.json',
      };
      secret = {
        NAKH_DATABASE_URL: `postgresql://${binding.databaseUser}:fixture-only@${binding.databaseHost}/${binding.databaseName}?sslmode=verify-full`,
      };
    });
    afterAll(async () => {
      await database?.destroy();
      await isolated?.destroy();
    });
    it('allows concurrent readiness observations without changing launch authority or audits', async () => {
      const before = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM platform.audit_logs`.execute(database);
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          readVpsLaunchReadiness(binding, () => Promise.resolve(secret), host, connect),
        ),
      );
      for (const result of results)
        expect(result).toMatchObject({
          kind: 'private-vps-readiness',
          launchAuthorized: false,
          productionQualified: false,
        });
      const after = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM platform.audit_logs`.execute(database);
      expect(after.rows).toEqual(before.rows);
      expect(
        (
          await sql<{
            count: string;
          }>`SELECT count(*)::text AS count FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'`.execute(
            database,
          )
        ).rows[0]?.count,
      ).toBe('0');
    });
    it('rejects a native login different from the protected binding', async () => {
      const changed = { ...binding, databaseUser: 'different_owner' };
      const changedSecret = {
        NAKH_DATABASE_URL: secret.NAKH_DATABASE_URL.replace(
          binding.databaseUser + ':',
          'different_owner:',
        ),
      };
      await expect(
        readVpsLaunchReadiness(changed, () => Promise.resolve(changedSecret), host, connect),
      ).rejects.toThrow('Private VPS readiness unavailable.');
      await expect(
        database.selectNoFrom((eb) => eb.val(1).as('ready')).execute(),
      ).resolves.toHaveLength(1);
    });
    it('rejects host drift after native owner checks and closes the connection', async () => {
      let calls = 0;
      await expect(
        readVpsLaunchReadiness(
          binding,
          () => Promise.resolve(secret),
          () =>
            Promise.resolve({
              platform: 'linux',
              uid: 0,
              machineId: ++calls < 3 ? binding.machineId : 'c'.repeat(32),
            }),
          connect,
        ),
      ).rejects.toThrow('Private VPS readiness unavailable.');
      expect(calls).toBe(3);
    });
  },
);
