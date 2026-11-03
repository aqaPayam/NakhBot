import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  glob,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createIsolatedTestDatabase } from '../packages/persistence-postgres/src/testing/isolated-database.js';
import { createDatabase } from '../packages/persistence-postgres/src/database.js';
import {
  runMigrations,
  verifyMigrations,
} from '../packages/persistence-postgres/src/migrations.js';
import {
  integrationShardEnvironment,
  NATIVE_SHARDS,
  planIntegrationShards,
  parseIntegrationShardReport,
  verifyIntegrationShardCoverage,
  mergeIntegrationPartitions,
  type IntegrationShardReport,
  type NativeShard,
} from './postgres-integration-shards.js';
import { startNativeSiblingServices } from './postgres-integration-sibling.js';
import {
  createNativeShardReceipt,
  verifyNativeShardReceipts,
  nativeFileInventorySha256,
  type NativeRunSource,
  type NativeShardReceipt,
} from './postgres-integration-receipts.js';
import durations from './postgres-integration-durations.json' with { type: 'json' };

const url = process.env.NAKH_TEST_DATABASE_URL;
if (url === undefined) throw new Error('Native integration requires its PostgreSQL test service.');
if (process.env.CI === 'true' && process.env.NAKH_TEST_REDIS_URL === undefined)
  throw new Error('CI native integration requires its real Redis test service.');

const expectedFiles: string[] = [];
for await (const file of glob(
  ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
  {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
))
  expectedFiles.push(resolve(file));
expectedFiles.sort();
if (expectedFiles.length < 154)
  throw new Error('Native integration file inventory lost baseline coverage.');
const dispatch = planIntegrationShards(expectedFiles, durations.files);

const durationHash = createHash('sha256').update(JSON.stringify(durations)).digest('hex');
const args = process.argv.slice(2),
  selected = process.env.NAKH_NATIVE_SHARD;
if (
  (args.length !== 0 && (args.length !== 2 || args[0] !== '--verify')) ||
  (selected !== undefined && !/^[1-4]$/u.test(selected)) ||
  (args.length !== 0 && selected !== undefined)
)
  throw new Error('Native integration mode invalid.');
function currentSource(): NativeRunSource {
  const headSha = process.env.GITHUB_SHA ?? '',
    runId = process.env.GITHUB_RUN_ID ?? '',
    attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[a-f0-9]{40}$/u.test(headSha) ||
    !/^[1-9][0-9]{0,19}$/u.test(runId) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error('Native integration source context invalid.');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== headSha)
    throw new Error('Native integration source checkout mismatch.');
  return { headSha, runId, attempt };
}
async function writeAggregate(
  reports: readonly IntegrationShardReport[],
  receipts?: readonly NativeShardReceipt[],
): Promise<void> {
  const coverage = verifyIntegrationShardCoverage(reports, expectedFiles, 1286);
  const evidence = {
    schemaVersion: 1,
    scenario: 'POSTGRES-INTEGRATION-ISOLATED-SHARDS',
    ...coverage,
    dispatch: {
      mode: 'duration_balanced',
      estimatedMs: dispatch.estimatedMs,
      fileCounts: dispatch.files.map((files) => files.length),
      durationInventorySha256: durationHash,
    },
    fileInventorySha256: nativeFileInventorySha256(expectedFiles),
    ...(receipts === undefined
      ? {}
      : {
          executionMode: 'distributed_runners',
          sources: receipts.map((r) => ({
            shard: r.shard,
            ...r.source,
            total: r.report.total,
            passed: r.report.passed,
            fileCount: r.report.files.length,
          })),
        }),
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/postgres-integration-shards.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
}
async function verifyDistributed(directory: string): Promise<void> {
  const source = currentSource(),
    root = resolve(directory),
    path = relative(resolve('.'), root);
  if (path === '' || path.startsWith('..') || isAbsolute(path))
    throw new Error('Native receipt directory invalid.');
  const entries = await readdir(root, { withFileTypes: true });
  if (
    entries.length < NATIVE_SHARDS.length ||
    entries.length > NATIVE_SHARDS.length * source.attempt
  )
    throw new Error('Native receipt coverage incomplete.');
  const receipts: unknown[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^postgres-integration-shard-[1-4]-[1-9][0-9]*\.json$/u.test(entry.name)
    )
      throw new Error('Native receipt file invalid.');
    const path = join(root, entry.name);
    if ((await stat(path)).size > 131072) throw new Error('Native receipt size invalid.');
    try {
      receipts.push(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch {
      throw new Error('Native receipt JSON invalid; private details withheld.');
    }
  }
  const verified = verifyNativeShardReceipts(receipts, {
    source,
    expectedFiles,
    dispatch,
    durationInventorySha256: durationHash,
    minimumTests: 1286,
  });
  await writeAggregate(
    verified.receipts.map((r) => r.report),
    verified.receipts,
  );
}
async function requireNativeSettings(sourceUrl: string): Promise<void> {
  const settings = createDatabase({
    url: sourceUrl,
    poolMax: 1,
    statementTimeoutMs: 15000,
    lockTimeoutMs: 10000,
  });
  try {
    const row = await settings
      .selectNoFrom((eb) => [
        eb.fn<string>('current_setting', [eb.val('fsync')]).as('fsync'),
        eb.fn<string>('current_setting', [eb.val('synchronous_commit')]).as('commit'),
        eb.fn<string>('current_setting', [eb.val('full_page_writes')]).as('pages'),
      ])
      .executeTakeFirstOrThrow();
    if (row.fsync !== 'on' || row.commit !== 'on' || row.pages !== 'on')
      throw new Error('Native PostgreSQL requires synchronous WAL and full page-write protection.');
  } finally {
    await settings.destroy();
  }
}

async function execute(): Promise<void> {
  // Reuse the complete compiled workspace from this job's exact-source Docker
  // build. Partial package builds made CLI tests depend on unrelated suites'
  // shard placement. Local runs retain the ordinary dependency-closure builds.
  const compiledSource = process.env.NAKH_NATIVE_FIXTURES_SOURCE_SHA;
  const partitions = process.env.NAKH_NATIVE_PARTITIONS;
  if (
    partitions !== undefined &&
    (partitions !== '2' ||
      process.env.CI !== 'true' ||
      selected === undefined ||
      compiledSource === undefined)
  )
    throw new Error('Native partition execution requires the exact CI fixture context.');
  if (
    compiledSource !== undefined &&
    (process.env.CI !== 'true' ||
      selected === undefined ||
      compiledSource !== currentSource().headSha ||
      (await readFile('artifacts/native-fixtures/native-fixtures-source-sha.txt', 'utf8')) !==
        compiledSource + '\n')
  )
    throw new Error('Native compiled fixtures do not match the exact CI source.');
  await requireNativeSettings(url!);
  const temporary = await mkdtemp(join(tmpdir(), 'nakh-native-shards-'));
  const paths = new Set<string>();
  const children = new Set<ReturnType<typeof spawn>>();
  // Preserve a caller's diagnostic engine mode; CI's normal runtime adds no flags.
  const engineArguments = process.execArgv.filter((argument) => argument === '--no-opt');
  function stopChildren(): void {
    for (const child of children) child.kill('SIGTERM');
  }
  process.once('SIGINT', stopChildren);
  process.once('SIGTERM', stopChildren);

  async function runPartition(
    shard: NativeShard,
    partition: number,
    sourceUrl: string,
    redisUrl: string | undefined,
    files: readonly string[],
  ): Promise<IntegrationShardReport> {
    await requireNativeSettings(sourceUrl);
    const database = await createIsolatedTestDatabase(sourceUrl, `ci_native_${shard}_${partition}`);
    try {
      // Ordinary process cases run production compiled artifacts. Build only
      // their owning shard's dependency closure, sharing overlapping filters.
      // Native inventory, source receipts, CLI fixtures and time caps remain.
      const owned = new Set(
        files.map((file) => relative(resolve('.'), file).replaceAll('\\', '/')),
      );
      const buildFilters: string[] = [];
      if (
        [
          'packages/persistence-postgres/src/launch-operator-host.integration.test.ts',
          'packages/persistence-postgres/src/schema-compatibility.integration.test.ts',
          'packages/persistence-postgres/src/runtime-role-provisioning.integration.test.ts',
        ].some((file) => owned.has(file))
      )
        buildFilters.push('@nakh/persistence-postgres...');
      if (owned.has('apps/worker/src/stars-refund-runtime.integration.test.ts'))
        buildFilters.push('@nakh/worker...');
      if (owned.has('apps/api/src/admin-runtime.integration.test.ts'))
        buildFilters.push(
          '@nakh/api...',
          '@nakh/telegram-gateway...',
          '@nakh/worker...',
          '@nakh/scheduler...',
        );
      if (compiledSource === undefined && buildFilters.length > 0) {
        const manager = process.env.npm_execpath;
        if (manager === undefined || !isAbsolute(manager))
          throw new Error('Native process fixture requires package-manager execution.');
        execFileSync(
          process.execPath,
          [
            ...engineArguments,
            manager,
            ...buildFilters.flatMap((filter) => ['--filter', filter]),
            '-r',
            '--workspace-concurrency=1',
            '--if-present',
            'build',
          ],
          { stdio: 'inherit', timeout: 180000 },
        );
      }
      // Match the existing CI service's migrated and verified starting state.
      await runMigrations(database.url, resolve('migrations'));
      await verifyMigrations(database.url, resolve('migrations/verify'));
      const reportPath = join(temporary, `${shard}-${partition}.json`);
      paths.add(reportPath);
      process.stdout.write(
        JSON.stringify({
          scenario: 'POSTGRES-NATIVE-PARTITION',
          shard,
          partition,
          files: files.length,
        }) + '\n',
      );
      const code = await new Promise<number>((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...engineArguments,
            resolve('node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            'vitest.integration.config.ts',
            '--maxWorkers=1',
            ...engineArguments.map((argument) => `--execArgv=${argument}`),
            '--reporter=default',
            '--reporter=json',
            `--outputFile.json=${reportPath}`,
            ...files,
          ],
          {
            env: integrationShardEnvironment(
              {
                ...process.env,
                ...(redisUrl === undefined ? {} : { NAKH_TEST_REDIS_URL: redisUrl }),
              },
              database.url,
              shard,
            ),
            stdio: 'inherit',
          },
        );
        children.add(child);
        child.once('error', reject);
        child.once('close', (exitCode) => {
          children.delete(child);
          resolveExit(exitCode ?? 1);
        });
      });
      if (code !== 0) throw new Error(`Native integration shard ${shard} failed.`);
      return parseIntegrationShardReport(JSON.parse(await readFile(reportPath, 'utf8')) as unknown);
    } finally {
      await database.destroy();
    }
  }

  async function runShard(shard: NativeShard): Promise<IntegrationShardReport> {
    const files = dispatch.files[shard - 1]!;
    if (partitions === undefined || files.length < 2)
      return runPartition(shard, 1, url!, process.env.NAKH_TEST_REDIS_URL, files);
    const sibling = await startNativeSiblingServices();
    try {
      const groups = planIntegrationShards(files, durations.files, process.cwd(), 2).files;
      const results = await Promise.allSettled([
        runPartition(shard, 1, url!, process.env.NAKH_TEST_REDIS_URL, groups[0]!),
        runPartition(shard, 2, sibling.databaseUrl, sibling.redisUrl, groups[1]!),
      ]);
      const reports = results.map((result) => {
        if (result.status !== 'fulfilled') throw new Error('Native partition failed.');
        return result.value;
      });
      return mergeIntegrationPartitions(reports, files);
    } finally {
      await sibling.destroy();
    }
  }

  try {
    const shards = selected === undefined ? NATIVE_SHARDS : [Number(selected) as NativeShard];
    const results = await Promise.allSettled(shards.map(runShard));
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Native integration shards failed; no later acceptance gate is authorized.');
    const reports = results.map((result) => {
      if (result.status !== 'fulfilled') throw new Error('Native integration result missing.');
      return result.value;
    });
    if (selected !== undefined) {
      const receipt = createNativeShardReceipt({
        source: currentSource(),
        shard: Number(selected) as NativeShard,
        expectedFiles,
        dispatch,
        durationInventorySha256: durationHash,
        report: reports[0]!,
      });
      await mkdir('artifacts', { recursive: true });
      await writeFile(
        `artifacts/postgres-integration-shard-${receipt.shard}-${receipt.source.attempt}.json`,
        JSON.stringify(receipt, null, 2) + '\n',
      );
      process.stdout.write(
        JSON.stringify({
          scenario: 'POSTGRES-INTEGRATION-ISOLATED-SHARD',
          shard: receipt.shard,
          total: receipt.report.total,
          passed: receipt.report.passed,
          skipped: receipt.report.skipped,
        }) + '\n',
      );
    } else await writeAggregate(reports);
  } finally {
    process.removeListener('SIGINT', stopChildren);
    process.removeListener('SIGTERM', stopChildren);
    // Only the known files and newly created empty directory; no recursive deletion.
    for (const path of paths) await rm(path, { force: true });
    await rmdir(temporary);
  }
}
if (args.length === 2) await verifyDistributed(args[1]!);
else {
  if (selected !== undefined) currentSource();
  await execute();
}
