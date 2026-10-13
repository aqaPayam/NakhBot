import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIsolatedTestDatabase } from '../packages/persistence-postgres/src/testing/isolated-database.js';
import {
  runMigrations,
  verifyMigrations,
} from '../packages/persistence-postgres/src/migrations.js';
import {
  integrationShardEnvironment,
  parseIntegrationShardReport,
  verifyIntegrationShardCoverage,
  type IntegrationShardReport,
} from './postgres-integration-shards.js';

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
if (expectedFiles.length < 124)
  throw new Error('Native integration file inventory lost baseline coverage.');

const temporary = await mkdtemp(join(tmpdir(), 'nakh-native-shards-'));
const paths = [join(temporary, '1.json'), join(temporary, '2.json')];
const children = new Set<ReturnType<typeof spawn>>();
// Preserve a caller's diagnostic engine mode; CI's normal runtime adds no flags.
const engineArguments = process.execArgv.filter((argument) => argument === '--no-opt');
function stopChildren(): void {
  for (const child of children) child.kill('SIGTERM');
}
process.once('SIGINT', stopChildren);
process.once('SIGTERM', stopChildren);

async function runShard(shard: 1 | 2): Promise<IntegrationShardReport> {
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
          `--shard=${shard}/2`,
          '--maxWorkers=1',
          ...engineArguments.map((argument) => `--execArgv=${argument}`),
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${reportPath}`,
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
  const results = await Promise.allSettled([runShard(1), runShard(2)]);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Native integration shards failed; no later acceptance gate is authorized.');
  const reports = results.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('Native integration result missing.');
    return result.value;
  });
  process.stdout.write(
    JSON.stringify({
      scenario: 'POSTGRES-INTEGRATION-SHARD-OBSERVATION',
      shards: reports.length,
      reportedFiles: reports.reduce((sum, report) => sum + report.files.length, 0),
      total: reports.reduce((sum, report) => sum + report.total, 0),
      passed: reports.reduce((sum, report) => sum + report.passed, 0),
      failed: reports.reduce((sum, report) => sum + report.failed, 0),
      skipped: reports.reduce((sum, report) => sum + report.skipped, 0),
    }) + '\n',
  );
  const coverage = verifyIntegrationShardCoverage(reports, expectedFiles, 1006);
  const evidence = {
    schemaVersion: 1,
    scenario: 'POSTGRES-INTEGRATION-ISOLATED-SHARDS',
    ...coverage,
    fileInventorySha256: createHash('sha256')
      .update(
        expectedFiles
          .map((file) => file.slice(resolve('.').length + 1).replaceAll('\\', '/'))
          .join('\n'),
      )
      .digest('hex'),
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/postgres-integration-shards.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  process.removeListener('SIGINT', stopChildren);
  process.removeListener('SIGTERM', stopChildren);
  // Remove only the two known files and their newly created empty directory.
  // Never recursively delete a path supplied through configuration.
  for (const path of paths) await rm(path, { force: true });
  await rmdir(temporary);
}
