import { isAbsolute, relative, resolve } from 'node:path';

export const NATIVE_SHARDS = [1, 2, 3, 4] as const;
export type NativeShard = (typeof NATIVE_SHARDS)[number];

export type IntegrationShardReport = Readonly<{
  success: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  files: readonly string[];
}>;

function invalid(): never {
  throw new Error('Native integration shard coverage is incomplete or invalid.');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function canonical(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Durations affect dispatch only. Unknown files still run, and the independent
 * coverage verifier must account for every discovered file and every test. */
export function planIntegrationShards(
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  directory = process.cwd(),
): Readonly<{
  files: readonly (readonly string[])[];
  estimatedMs: readonly number[];
}> {
  if (
    files.length < NATIVE_SHARDS.length ||
    new Set(files.map(canonical)).size !== files.length ||
    Object.values(durations).some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    invalid();
  const candidates = files.map((file) => {
    const key = relative(resolve(directory), resolve(file)).replaceAll('\\', '/');
    if (isAbsolute(key) || key.startsWith('../') || !key.endsWith('.integration.test.ts'))
      invalid();
    return { file, key, ms: durations[key] ?? 30000 };
  });
  candidates.sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const buckets = NATIVE_SHARDS.map((): string[] => []);
  const totals = NATIVE_SHARDS.map(() => 0);
  for (const candidate of candidates) {
    const shard = totals.indexOf(Math.min(...totals));
    buckets[shard]!.push(candidate.file);
    totals[shard] = totals[shard]! + candidate.ms;
    if (!Number.isSafeInteger(totals[shard])) invalid();
  }
  return {
    files: Object.freeze(buckets.map((bucket) => Object.freeze(bucket))),
    estimatedMs: Object.freeze(totals),
  };
}

/** Read only coverage facts; assertion text and private fixture diagnostics are
 * never copied into the retained aggregate report. */
export function parseIntegrationShardReport(value: unknown): IntegrationShardReport {
  const report = object(value);
  if (typeof report.success !== 'boolean' || !Array.isArray(report.testResults)) invalid();
  const files = report.testResults.map((entry: unknown) => {
    const file = object(entry).name;
    if (typeof file !== 'string' || file.length === 0) invalid();
    return file;
  });
  const result = {
    success: report.success,
    total: count(report.numTotalTests),
    passed: count(report.numPassedTests),
    failed: count(report.numFailedTests),
    skipped: count(report.numPendingTests),
    files,
  };
  if (result.total !== result.passed + result.failed + result.skipped) invalid();
  return result;
}

export function verifyIntegrationShardCoverage(
  reports: readonly IntegrationShardReport[],
  expectedFiles: readonly string[],
  minimumTests: number,
): Readonly<{ shards: number; testFiles: number; total: number; passed: number; skipped: number }> {
  if (
    reports.length !== NATIVE_SHARDS.length ||
    expectedFiles.length === 0 ||
    count(minimumTests) < 1
  )
    invalid();
  const expected = new Set(expectedFiles.map(canonical));
  if (expected.size !== expectedFiles.length) invalid();
  const seen = new Set<string>();
  let total = 0;
  for (const report of reports) {
    if (!report.success || report.failed !== 0 || report.skipped !== 0 || report.passed < 1)
      invalid();
    for (const originalFile of report.files) {
      const file = canonical(originalFile);
      if (!expected.has(file) || seen.has(file)) invalid();
      seen.add(file);
    }
    total += report.total;
  }
  if (seen.size !== expected.size || total < minimumTests) invalid();
  return { shards: NATIVE_SHARDS.length, testFiles: seen.size, total, passed: total, skipped: 0 };
}

/** Give each child its own real databases. Even fixed queue/token names cannot
 * borrow another shard's state. Provider credentials never enter the report. */
export function integrationShardEnvironment(
  original: NodeJS.ProcessEnv,
  postgresUrl: string,
  shard: NativeShard,
): NodeJS.ProcessEnv {
  if (!NATIVE_SHARDS.includes(shard)) invalid();
  const database = new URL(postgresUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) invalid();
  const environment: NodeJS.ProcessEnv = {
    ...original,
    NAKH_TEST_DATABASE_URL: postgresUrl,
    NAKH_DATABASE_URL: postgresUrl,
    PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
  };
  const redisSource = original.NAKH_TEST_REDIS_URL;
  if (redisSource !== undefined) {
    const redis = new URL(redisSource);
    if (!['redis:', 'rediss:'].includes(redis.protocol)) invalid();
    const base =
      redis.pathname === '' || redis.pathname === '/' ? 0 : Number(redis.pathname.slice(1));
    // DB 15 belongs exclusively to the composed HTTP/Redis fixture. All four
    // ordinary shard contexts must remain distinct from it and one another.
    if (!Number.isSafeInteger(base) || base < 0 || base > 14 - NATIVE_SHARDS.length) invalid();
    redis.pathname = `/${base + shard}`;
    environment.NAKH_TEST_REDIS_URL = redis.toString();
    environment.NAKH_REDIS_URL = redis.toString();
  }
  return environment;
}
