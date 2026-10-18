import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConfig, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresLaunchCohortAdmission, type LaunchCohortCommand } from './launch-cohort-store.js';
import {
  launchOperatorCommandDigest,
  runLaunchOperator,
  type LaunchOperatorBinding,
} from './launch-operator-host.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import {
  launchOperatorFixture,
  launchOperatorFixtureAws,
} from './testing/launch-operator-fixture.js';

const source = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(source === undefined)(
  'protected cohort operator with native owner and audit authority',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      database: NakhDatabase,
      binding: LaunchOperatorBinding,
      userId: string,
      admission: PostgresLaunchCohortAdmission,
      opening: { operation: 'apply'; input: LaunchCohortCommand };
    const telegramUserId = '123456789012';
    const connect = (config: DatabaseConfig): NakhDatabase =>
      createDatabase({ ...config, url: isolated.url });
    const run = (request: unknown, config = binding): Promise<unknown> =>
      runLaunchOperator(config, request, launchOperatorFixtureAws(config), connect);
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(source!, 'nakh_m9_launch_host');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 2,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const url = new URL(isolated.url);
      binding = launchOperatorFixture(
        decodeURIComponent(url.pathname.slice(1)),
        decodeURIComponent(url.username),
      );
      userId = await createReportUser(database);
      const now = new Date();
      await database
        .insertInto('identity.telegram_identities')
        .values({
          user_id: userId,
          telegram_user_id: telegramUserId,
          username: null,
          first_seen_at: now,
          last_seen_at: now,
        })
        .execute();
      admission = new PostgresLaunchCohortAdmission(database, {
        sourceSha: binding.sourceSha,
        environment: binding.environment,
        telegramBotId: binding.telegramBotId,
      });
    });
    afterAll(async () => {
      await database?.destroy();
      await isolated?.destroy();
    });
    it('inspects closed-by-default authority and resolves only a private exact current member', async () => {
      expect(await run({ operation: 'inspect' })).toBeNull();
      expect(await run({ operation: 'resolve-member', telegramUserId })).toEqual({
        userId,
        productEpoch: 0,
      });
      expect(await run({ operation: 'resolve-member', telegramUserId: '999999999999' })).toBeNull();
      expect(await admission.allows(userId)).toBe(false);
    });
    it('converges twenty approved host retries to one native policy and member audit', async () => {
      opening = {
        operation: 'apply',
        input: {
          requestId: randomUUID(),
          expectedVersion: 0,
          sourceSha: binding.sourceSha,
          environment: binding.environment,
          telegramBotId: binding.telegramBotId,
          mode: 'cohort',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          reviewDigest: 'b'.repeat(64),
          members: [{ userId, productEpoch: 0 }],
        },
      };
      const config = { ...binding, approvedCommandDigest: launchOperatorCommandDigest(opening) };
      const results = await Promise.all(Array.from({ length: 20 }, () => run(opening, config)));
      expect(results.filter((result) => !(result as { replayed: boolean }).replayed)).toHaveLength(
        1,
      );
      expect(await admission.allows(userId)).toBe(true);
      expect(await run({ operation: 'inspect' })).toEqual({
        policyId: opening.input.requestId,
        version: 1,
        mode: 'cohort',
        sourceSha: binding.sourceSha,
        environment: binding.environment,
        telegramBotId: binding.telegramBotId,
        expiresAt: opening.input.expiresAt,
        cohortSize: 1,
        reviewDigest: opening.input.reviewDigest,
      });
      const rows = await database
        .selectFrom('platform.audit_logs')
        .select(['event_type', 'metadata'])
        .where('command_id', '=', opening.input.requestId)
        .execute();
      expect(rows).toHaveLength(2);
      expect(
        rows.find((row) => row.event_type === 'platform.launch-policy-applied.v1')!.metadata,
      ).toMatchObject({ operatorId: binding.operatorId });
    });
    it('captures approval, authority and original member life before asynchronous provider access', async () => {
      const request = {
        operation: 'apply' as const,
        input: {
          ...opening.input,
          members: opening.input.members.map((member) => ({ ...member })),
        },
      };
      request.input.requestId = randomUUID();
      request.input.expectedVersion = 1;
      const originalId = request.input.requestId;
      const config = { ...binding, approvedCommandDigest: launchOperatorCommandDigest(request) };
      const provider = launchOperatorFixtureAws(structuredClone(config));
      let first = true;
      await runLaunchOperator(
        config,
        request,
        async (...args) => {
          if (first) {
            first = false;
            config.operatorId = randomUUID();
            config.sourceSha = 'c'.repeat(40);
            request.input.members = [{ userId, productEpoch: 99 }];
            request.input.requestId = randomUUID();
          }
          return provider(...args);
        },
        connect,
      );
      expect(await admission.allows(userId)).toBe(true);
      const row = await database
        .selectFrom('platform.audit_logs')
        .select('metadata')
        .where('id', '=', originalId)
        .executeTakeFirstOrThrow();
      expect(row.metadata).toMatchObject({
        operatorId: binding.operatorId,
        sourceSha: binding.sourceSha,
        version: 2,
      });
      expect(
        await database
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('id', '=', request.input.requestId)
          .executeTakeFirst(),
      ).toBeUndefined();
    });
    it('closes without opening approval and never reopens from an old approved replay', async () => {
      const close = {
        operation: 'apply',
        input: {
          ...opening.input,
          requestId: randomUUID(),
          expectedVersion: 2,
          mode: 'closed',
          expiresAt: null,
          members: [],
        },
      };
      const closed = await Promise.all(Array.from({ length: 20 }, () => run(close)));
      expect(closed.filter((result) => !(result as { replayed: boolean }).replayed)).toHaveLength(
        1,
      );
      expect(await admission.allows(userId)).toBe(false);
      expect(
        await run(opening, {
          ...binding,
          approvedCommandDigest: launchOperatorCommandDigest(opening),
        }),
      ).toMatchObject({ replayed: true, latest: false, version: 1 });
      expect(await admission.allows(userId)).toBe(false);
      const changed = {
        operation: 'apply',
        input: { ...opening.input, reviewDigest: 'c'.repeat(64) },
      };
      await expect(
        run(changed, { ...binding, approvedCommandDigest: launchOperatorCommandDigest(changed) }),
      ).rejects.toThrow('Launch operator unavailable.');
      expect(await run({ operation: 'inspect' })).toMatchObject({
        version: 3,
        mode: 'closed',
        cohortSize: 0,
      });
    });
    it('rechecks the final principal and native database/login owner before any operation', async () => {
      const before = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM platform.audit_logs
      WHERE event_type='platform.launch-policy-applied.v1'`.execute(database);
      for (const config of [
        { ...binding, databaseUser: 'different_owner' },
        { ...binding, databaseName: 'different_database' },
      ])
        await expect(run({ operation: 'inspect' }, config)).rejects.toThrow(
          'Launch operator unavailable.',
        );
      const deniedOpening = {
        operation: 'apply',
        input: { ...opening.input, requestId: randomUUID(), expectedVersion: 3 },
      };
      const approvedBinding = {
        ...binding,
        approvedCommandDigest: launchOperatorCommandDigest(deniedOpening),
      };
      const provider = launchOperatorFixtureAws(approvedBinding);
      let calls = 0;
      await expect(
        runLaunchOperator(
          approvedBinding,
          deniedOpening,
          async (...args) => {
            calls++;
            return calls === 4
              ? {
                  Account: binding.accountId,
                  Arn: binding.principalArn,
                  UserId: 'replaced-principal',
                }
              : provider(...args);
          },
          connect,
        ),
      ).rejects.toThrow('Launch operator unavailable.');
      expect(calls).toBe(4);
      const after = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM platform.audit_logs
      WHERE event_type='platform.launch-policy-applied.v1'`.execute(database);
      expect(after.rows).toEqual(before.rows);
      expect(await admission.allows(userId)).toBe(false);
    });
    it('runs the compiled private digest CLI and refuses to overwrite an existing receipt', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'nakh-launch-operator-'));
      const commandPath = join(directory, 'command.json'),
        receiptPath = join(directory, 'receipt.json');
      const cli = resolve('packages/persistence-postgres/dist/cli/launch-operator.js');
      const invoke = (): Promise<{ stdout: string; stderr: string }> =>
        promisify(execFile)(
          process.execPath,
          ['--jitless', cli, '--digest', commandPath, receiptPath],
          { timeout: 30000, maxBuffer: 65536 },
        );
      try {
        await writeFile(commandPath, JSON.stringify(opening), { mode: 0o600 });
        const result = await invoke();
        expect(JSON.parse(result.stdout)).toEqual({ completed: true, digestOnly: true });
        expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual({
          commandDigest: launchOperatorCommandDigest(opening),
        });
        await expect(invoke()).rejects.toThrow();
        expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual({
          commandDigest: launchOperatorCommandDigest(opening),
        });
        expect(await admission.allows(userId)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
