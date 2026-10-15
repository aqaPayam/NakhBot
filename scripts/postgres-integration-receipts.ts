import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  NATIVE_SHARDS,
  verifyIntegrationShardCoverage,
  type IntegrationShardReport,
  type NativeShard,
} from './postgres-integration-shards.js';
export type NativeRunSource = Readonly<{ headSha: string; runId: string; attempt: number }>;
export type NativeShardReceipt = Readonly<{
  schemaVersion: 1;
  source: NativeRunSource;
  shard: NativeShard;
  fileInventorySha256: string;
  durationInventorySha256: string;
  report: IntegrationShardReport;
}>;
type Dispatch = Readonly<{ files: readonly (readonly string[])[]; estimatedMs: readonly number[] }>;
function invalid(): never {
  throw new Error('Native integration receipt coverage is incomplete or invalid.');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) invalid();
  return v;
}
function source(value: unknown): NativeRunSource {
  const v = object(value, ['headSha', 'runId', 'attempt']);
  if (
    typeof v.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(v.headSha) ||
    typeof v.runId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(v.runId) ||
    typeof v.attempt !== 'number' ||
    !Number.isSafeInteger(v.attempt) ||
    v.attempt < 1
  )
    invalid();
  return { headSha: v.headSha, runId: v.runId, attempt: v.attempt };
}
function portable(value: string): boolean {
  return (
    !isAbsolute(value) &&
    /^(?:apps|packages)\//u.test(value) &&
    value.endsWith('.integration.test.ts') &&
    !value.includes('\\') &&
    value.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  );
}
export function portableNativeFiles(files: readonly string[]): string[] {
  const result = files.map((file) => {
    const p = isAbsolute(file) ? relative(resolve('.'), file).replaceAll('\\', '/') : file;
    if (!portable(p)) invalid();
    return p;
  });
  if (new Set(result).size !== result.length) invalid();
  return result;
}
export function nativeFileInventorySha256(files: readonly string[]): string {
  return createHash('sha256').update(portableNativeFiles(files).sort().join('\n')).digest('hex');
}
function report(value: unknown, expectedFiles: readonly string[]): IntegrationShardReport {
  const v = object(value, ['success', 'total', 'passed', 'failed', 'skipped', 'files']);
  if (
    v.success !== true ||
    !Array.isArray(v.files) ||
    v.files.some((p: unknown) => typeof p !== 'string' || !portable(p))
  )
    invalid();
  for (const key of ['total', 'passed', 'failed', 'skipped'])
    if (typeof v[key] !== 'number' || !Number.isSafeInteger(v[key]) || v[key] < 0) invalid();
  if (v.failed !== 0 || v.skipped !== 0 || v.total !== v.passed || (v.passed as number) < 1)
    invalid();
  const files = v.files as string[],
    expected = portableNativeFiles(expectedFiles);
  if (
    files.length !== expected.length ||
    new Set(files).size !== files.length ||
    files.some((p) => !expected.includes(p))
  )
    invalid();
  return {
    success: true,
    total: v.total as number,
    passed: v.passed as number,
    failed: 0,
    skipped: 0,
    files: [...files],
  };
}
/** Retain only fixed coverage facts, never raw assertion text, URLs, credentials
 * or provider/fixture output. Every shard is bound to its exact source and plan. */
export function createNativeShardReceipt(
  input: Readonly<{
    source: NativeRunSource;
    shard: NativeShard;
    expectedFiles: readonly string[];
    dispatch: Dispatch;
    durationInventorySha256: string;
    report: IntegrationShardReport;
  }>,
): NativeShardReceipt {
  const context = source(input.source);
  if (
    !NATIVE_SHARDS.includes(input.shard) ||
    !/^[a-f0-9]{64}$/u.test(input.durationInventorySha256) ||
    input.dispatch.files.length !== NATIVE_SHARDS.length
  )
    invalid();
  return {
    schemaVersion: 1,
    source: context,
    shard: input.shard,
    fileInventorySha256: nativeFileInventorySha256(input.expectedFiles),
    durationInventorySha256: input.durationInventorySha256,
    report: report(
      { ...input.report, files: portableNativeFiles(input.report.files) },
      input.dispatch.files[input.shard - 1]!,
    ),
  };
}
/** The dependent reliability job independently discovers the current inventory
 * and verifies all four successful source-bound receipts before any later gate.
 * Earlier successful attempts are usable only in this same unchanged workflow
 * run; dependency success is also required by the actual GitHub job graph. */
export function verifyNativeShardReceipts(
  values: readonly unknown[],
  input: Readonly<{
    source: NativeRunSource;
    expectedFiles: readonly string[];
    dispatch: Dispatch;
    durationInventorySha256: string;
    minimumTests: number;
  }>,
): Readonly<{
  coverage: ReturnType<typeof verifyIntegrationShardCoverage>;
  receipts: readonly NativeShardReceipt[];
}> {
  const expected = source(input.source),
    inventory = nativeFileInventorySha256(input.expectedFiles),
    selected = new Map<NativeShard, NativeShardReceipt>(),
    attempts = new Set<string>();
  if (
    values.length < NATIVE_SHARDS.length ||
    values.length > NATIVE_SHARDS.length * expected.attempt ||
    input.dispatch.files.length !== NATIVE_SHARDS.length ||
    !/^[a-f0-9]{64}$/u.test(input.durationInventorySha256)
  )
    invalid();
  for (const value of values) {
    const v = object(value, [
        'schemaVersion',
        'source',
        'shard',
        'fileInventorySha256',
        'durationInventorySha256',
        'report',
      ]),
      origin = source(v.source);
    if (
      v.schemaVersion !== 1 ||
      !NATIVE_SHARDS.includes(v.shard as NativeShard) ||
      origin.headSha !== expected.headSha ||
      origin.runId !== expected.runId ||
      origin.attempt > expected.attempt ||
      v.fileInventorySha256 !== inventory ||
      v.durationInventorySha256 !== input.durationInventorySha256
    )
      invalid();
    const shard = v.shard as NativeShard,
      key = `${shard}:${origin.attempt}`;
    if (attempts.has(key)) invalid();
    attempts.add(key);
    const receipt: NativeShardReceipt = {
      schemaVersion: 1,
      source: origin,
      shard,
      fileInventorySha256: inventory,
      durationInventorySha256: input.durationInventorySha256,
      report: report(v.report, input.dispatch.files[shard - 1]!),
    };
    if ((selected.get(shard)?.source.attempt ?? 0) < origin.attempt) selected.set(shard, receipt);
  }
  const receipts = NATIVE_SHARDS.map((shard) => {
    const receipt = selected.get(shard);
    if (receipt === undefined) invalid();
    return receipt;
  });
  const coverage = verifyIntegrationShardCoverage(
    receipts.map((r) => r.report),
    input.expectedFiles,
    input.minimumTests,
  );
  return { coverage, receipts };
}
