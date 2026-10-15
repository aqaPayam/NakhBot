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
  type IntegrationShardReport,
  type NativeShard,
} from './postgres-integration-shards.js';
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
if (expectedFiles.length < 152)
  throw new Error('Native integration file inventory lost baseline coverage.');
const dispatch = planIntegrationShards(expectedFiles, durations.files);

const durationHash = createHash('sha256').update(JSON.stringify(durations)).digest('hex');
const args = process.argv.slice(2),
  selected = process.env.NAKH_NATIVE_SHARD;
if (
  (args.length !== 0 && (args.length !== 2 || args[0] !== '--verify')) ||
  (selected !== undefined && !/^[123]$/u.test(selected)) ||
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
  const coverage = verifyIntegrationShardCoverage(reports, expectedFiles, 1242);
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
  if (entries.length < 3 || entries.length > 3 * source.attempt)
    throw new Error('Native receipt coverage incomplete.');
  const receipts: unknown[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^postgres-integration-shard-[123]-[1-9][0-9]*\.json$/u.test(entry.name)
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
    minimumTests: 1233,
  });
  await writeAggregate(
    verified.receipts.map((r) => r.report),
    verified.receipts,
  );
}
async function execute(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'nakh-native-shards-'));
  const paths = NATIVE_SHARDS.map((shard) => join(temporary, `${shard}.json`));
  const children = new Set<ReturnType<typeof spawn>>();
  // Preserve a caller's diagnostic engine mode; CI's normal runtime adds no flags.
  const engineArguments = process.execArgv.filter((argument) => argument === '--no-opt');
  function stopChildren(): void {
    for (const child of children) child.kill('SIGTERM');
  }
  process.once('SIGINT', stopChildren);
  process.once('SIGTERM', stopChildren);

  async function runShard(shard: NativeShard): Promise<IntegrationShardReport> {
    const database = await createIsolatedTestDatabase(url!, `ci_native_${shard}`);
    try {
      // Match the existing CI service's migrated and verified starting state.
      await runMigrations(database.url, resolve('migrations'));
      await verifyMigrations(database.url, resolve('migrations/verify'));
      const reportPath = paths[shard - 1]!;
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
            ...dispatch.files[shard - 1]!,
          ],
          { env: integrationShardEnvironment(process.env, database.url, shard), stdio: 'inherit' },
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
