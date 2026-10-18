import { randomUUID, createHash } from 'node:crypto';
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
import {
  PostgresLaunchCohortAdmission,
  PostgresLaunchCohortControl,
  type LaunchCohortCommand,
} from './launch-cohort-store.js';
import {
  launchOperatorCommandDigest,
  runLaunchOperator,
  type LaunchOperatorBinding,
} from './launch-operator-host.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { launchReconciliationHealthStatement } from './launch-health-store.js';
import {
  LAUNCH_REVIEW_COMMON_EVIDENCE,
  LAUNCH_REVIEW_DRILL_EVIDENCE,
  launchReviewIntentDigest,
} from './launch-review.js';
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
    let preparedReview: unknown, reviewedCommand: unknown;
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
    it('collects source-bound native metadata and missing-evidence holds without starting jobs or changing authority', async () => {
      const before = await sql<{ audits: string; outbox: string; runs: string }>`SELECT
        (SELECT count(*)::text FROM platform.audit_logs) AS audits,
        (SELECT count(*)::text FROM platform.outbox_events) AS outbox,
        (SELECT count(*)::text FROM billing.reconciliation_runs) AS runs`.execute(database);
      const observation = (await run({ operation: 'health' })) as {
        observationScope: string;
        audience: object;
        launchAuthorized: boolean;
        reconciliation: { status: string | null }[];
      };
      expect(observation).toMatchObject({
        observationScope: 'native_metadata',
        launchAuthorized: false,
        audience: {
          sourceSha: binding.sourceSha,
          environment: binding.environment,
          telegramBotId: binding.telegramBotId,
        },
      });
      expect(observation.reconciliation).toHaveLength(4);
      expect(observation.reconciliation.every((run) => run.status === null)).toBe(true);
      const review = (await run({
        operation: 'prepare-review',
        phase: 'cohort',
        intent: { ...opening.input, requestId: randomUUID(), expectedVersion: 3 },
        evidence: [],
      })) as { dossier: { blockers: string[]; launchAuthorized: boolean } };
      expect(review.dossier.launchAuthorized).toBe(false);
      expect(review.dossier.blockers).toEqual(
        expect.arrayContaining([
          'missing_deployment',
          'missing_payment_drill',
          'reconciliation_billing',
          'safety_scan_freshness',
        ]),
      );
      const after = await sql<{ audits: string; outbox: string; runs: string }>`SELECT
        (SELECT count(*)::text FROM platform.audit_logs) AS audits,
        (SELECT count(*)::text FROM platform.outbox_events) AS outbox,
        (SELECT count(*)::text FROM billing.reconciliation_runs) AS runs`.execute(database);
      expect(after.rows).toEqual(before.rows);
      expect(await admission.allows(userId)).toBe(false);
    });
    it('binds fresh native observations to every review role while leaving actual evidence acceptance to the human operator', async () => {
      const now = new Date();
      for (const run_type of ['billing', 'nakh', 'chat', 'moderation'] as const)
        await database
          .insertInto('billing.reconciliation_runs')
          .values({
            id: randomUUID(),
            run_type,
            status: 'succeeded',
            cursor: {},
            failure_code: null,
            started_at: new Date(now.getTime() - 60000),
            finished_at: new Date(now.getTime() - 30000),
          })
          .execute();
      const intent = { ...opening.input, requestId: randomUUID(), expectedVersion: 3 };
      const result = (await run({
        operation: 'prepare-review',
        phase: 'daily',
        intent,
        evidence: [...LAUNCH_REVIEW_COMMON_EVIDENCE, ...LAUNCH_REVIEW_DRILL_EVIDENCE].map(
          (role) => ({
            role,
            sha256: 'd'.repeat(64),
            observedAt: new Date(now.getTime() - 1000).toISOString(),
            expiresAt: new Date(now.getTime() + 3600000).toISOString(),
          }),
        ),
      })) as {
        reviewDigest: string;
        dossier: {
          blockers: string[];
          launchAuthorized: boolean;
          requiresHumanApproval: boolean;
          evidenceVerification: string;
          intentDigest: string;
          nativeHealth: { reconciliation: { status: string }[] };
        };
      };
      preparedReview = result;
      reviewedCommand = {
        operation: 'apply',
        input: { ...intent, reviewDigest: result.reviewDigest },
      };
      expect(result.reviewDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.dossier).toMatchObject({
        launchAuthorized: false,
        requiresHumanApproval: true,
        evidenceVerification: 'operator_supplied_bytes',
        intentDigest: launchReviewIntentDigest(intent),
      });
      expect(result.dossier.blockers).toEqual([]);
      expect(
        result.dossier.nativeHealth.reconciliation.every((run) => run.status === 'succeeded'),
      ).toBe(true);
      expect(await admission.allows(userId)).toBe(false);
    });
    it('keeps the four latest-run probes indexed at twenty thousand rows under the original execution budget', async () => {
      class Rollback extends Error {}
      await expect(
        database.transaction().execute(async (tx) => {
          await sql`INSERT INTO billing.reconciliation_runs(id,run_type,status,started_at,finished_at)
          SELECT gen_random_uuid(),(ARRAY['billing','nakh','chat','moderation'])[1+(n%4)],'succeeded',
            clock_timestamp()-(n+100)*interval '1 second',clock_timestamp()-(n+99)*interval '1 second'
          FROM generate_series(1,20000) n`.execute(tx);
          await sql`ANALYZE billing.reconciliation_runs`.execute(tx);
          await sql`SET LOCAL jit = off`.execute(tx);
          await sql`SET LOCAL max_parallel_workers_per_gather = 0`.execute(tx);
          const result = await sql<{
            'QUERY PLAN': { 'Execution Time': number; Plan: object }[];
          }>`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          ${launchReconciliationHealthStatement()}`.execute(tx);
          const plan = result.rows[0]!['QUERY PLAN'][0]!;
          expect(Number.isFinite(plan['Execution Time'])).toBe(true);
          expect(plan['Execution Time']).toBeLessThanOrEqual(1500);
          expect(JSON.stringify(plan.Plan)).toContain('reconciliation_runs_time_idx');
          const rows = (await launchReconciliationHealthStatement().execute(tx)).rows;
          expect(rows).toHaveLength(4);
          expect(rows.every((row) => row.status === 'succeeded')).toBe(true);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      const count = await database
        .selectFrom('billing.reconciliation_runs')
        .select(sql<string>`count(*)::text`.as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(count.count)).toBe(4);
    });
    it('verifies the native dossier with the compiled offline CLI without granting admission', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'nakh-review-reference-'));
      const reportPath = join(directory, 'review.json'),
        commandPath = join(directory, 'command.json'),
        receiptPath = join(directory, 'receipt.json');
      try {
        await writeFile(reportPath, JSON.stringify(preparedReview), { mode: 0o600 });
        await writeFile(commandPath, JSON.stringify(reviewedCommand), { mode: 0o600 });
        const result = await promisify(execFile)(
          process.execPath,
          [
            '--jitless',
            resolve('packages/persistence-postgres/dist/cli/launch-operator.js'),
            '--verify-review',
            reportPath,
            commandPath,
            receiptPath,
          ],
          { timeout: 30000, maxBuffer: 65536 },
        );
        expect(JSON.parse(result.stdout)).toEqual({
          completed: true,
          reviewReferenceVerified: true,
        });
        expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual({
          reviewReferenceVerified: true,
          launchAuthorized: false,
          requiresHumanApproval: true,
        });
        expect(await admission.allows(userId)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    it('rejects unreviewed, missing and expired opening dossiers before reserving output or invoking AWS', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'nakh-review-denial-'));
      const bindingPath = join(directory, 'binding.json'),
        commandPath = join(directory, 'command.json'),
        reportPath = join(directory, 'expired.json');
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
      );
      environment.PATH = ''; // Any accidental provider invocation cannot resolve an AWS executable.
      try {
        await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
        const expired = JSON.parse(JSON.stringify(preparedReview)) as {
          reviewDigest: string;
          dossier: Record<string, unknown>;
        };
        expired.dossier.expiresAt = new Date(Date.now() - 1000).toISOString();
        expired.reviewDigest = createHash('sha256')
          .update(JSON.stringify(expired.dossier))
          .digest('hex');
        await writeFile(reportPath, JSON.stringify(expired), { mode: 0o600 });
        const selected = reviewedCommand as { operation: string; input: LaunchCohortCommand };
        const commands = [
          selected,
          {
            operation: 'apply-reviewed',
            input: selected.input,
            reviewPath: join(directory, 'missing.json'),
          },
          {
            operation: 'apply-reviewed',
            input: { ...selected.input, reviewDigest: expired.reviewDigest },
            reviewPath: reportPath,
          },
        ];
        for (const [index, command] of commands.entries()) {
          await writeFile(commandPath, JSON.stringify(command), { mode: 0o600 });
          const outputPath = join(directory, `denied-${index}.json`);
          await expect(
            promisify(execFile)(
              process.execPath,
              [
                '--jitless',
                resolve('packages/persistence-postgres/dist/cli/launch-operator.js'),
                bindingPath,
                commandPath,
                outputPath,
              ],
              { env: environment, timeout: 30000, maxBuffer: 65536 },
            ),
          ).rejects.toMatchObject({ code: 1 });
          await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(await admission.allows(userId)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    it('expires reviewed admission under the native lock without writing a policy', async () => {
      let signal!: (value: string) => void;
      const acquired = new Promise<string>((resolve) => {
        signal = resolve;
      });
      const holder = database.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
        const row = (
          await sql<{ expiry: string }>`SELECT to_char((clock_timestamp()+interval '0.25 second')
          AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expiry`.execute(tx)
        ).rows[0]!;
        signal(row.expiry);
        await sql`SELECT pg_sleep(0.8)`.execute(tx);
      });
      try {
        const deadline = await Promise.race([
          acquired,
          holder.then((): never => {
            throw new Error('Lock was not signalled.');
          }),
        ]);
        const fresh = (
          await sql<{
            fresh: boolean;
          }>`SELECT clock_timestamp()<${deadline}::timestamptz AS fresh`.execute(database)
        ).rows[0]!;
        expect(fresh.fresh).toBe(true);
        const command = { ...opening.input, requestId: randomUUID(), expectedVersion: 3 };
        await expect(
          new PostgresLaunchCohortControl(database, { operatorId: binding.operatorId }).apply(
            command,
            deadline,
          ),
        ).rejects.toThrow();
        expect(
          await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('id', '=', command.requestId)
            .executeTakeFirst(),
        ).toBeUndefined();
        expect(await admission.allows(userId)).toBe(false);
      } finally {
        await holder;
      }
    });
    it('applies the reviewed host envelope with exact approval, then closes and preserves old replay fencing', async () => {
      const selected = reviewedCommand as { operation: string; input: LaunchCohortCommand };
      const command = {
        operation: 'apply-reviewed',
        input: selected.input,
        review: preparedReview,
      };
      const config = { ...binding, approvedCommandDigest: launchOperatorCommandDigest(command) };
      expect(await run(command, config)).toMatchObject({
        version: 4,
        replayed: false,
        latest: true,
      });
      expect(await admission.allows(userId)).toBe(true);
      expect(
        await run({
          operation: 'apply',
          input: {
            ...selected.input,
            requestId: randomUUID(),
            expectedVersion: 4,
            mode: 'closed',
            members: [],
            expiresAt: null,
          },
        }),
      ).toMatchObject({ version: 5 });
      expect(await admission.allows(userId)).toBe(false);
      expect(await run(command, config)).toMatchObject({
        version: 4,
        replayed: true,
        latest: false,
      });
      expect(await run({ operation: 'receipt', input: selected.input })).toMatchObject({
        version: 4,
        replayed: true,
        latest: false,
      });
      expect(
        await run({ operation: 'receipt', input: { ...selected.input, requestId: randomUUID() } }),
      ).toBeNull();
      await expect(
        run({ operation: 'receipt', input: { ...selected.input, reviewDigest: 'f'.repeat(64) } }),
      ).rejects.toThrow('Launch operator unavailable.');
      expect(await admission.allows(userId)).toBe(false);
    });
  },
);
