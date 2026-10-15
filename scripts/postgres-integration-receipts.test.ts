import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_SHARDS, planIntegrationShards } from './postgres-integration-shards.js';
import {
  createNativeShardReceipt,
  verifyNativeShardReceipts,
  type NativeShardReceipt,
} from './postgres-integration-receipts.js';
function fixture(attempt = 1): Readonly<{
  input: Parameters<typeof verifyNativeShardReceipts>[1];
  receipts: NativeShardReceipt[];
}> {
  const expectedFiles = [
    'packages/a.integration.test.ts',
    'apps/b.integration.test.ts',
    'packages/c.integration.test.ts',
  ].map((p) => resolve(p));
  const dispatch = planIntegrationShards(expectedFiles, {}),
    source = { headSha: 'a'.repeat(40), runId: '123', attempt },
    durationInventorySha256 = 'c'.repeat(64);
  const input = { source, expectedFiles, dispatch, durationInventorySha256, minimumTests: 3 };
  const receipts = NATIVE_SHARDS.map((shard) =>
    createNativeShardReceipt({
      ...input,
      shard,
      report: {
        success: true,
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        files: dispatch.files[shard - 1]!,
      },
    }),
  );
  return { input, receipts };
}
describe('source-bound independent native runner receipts', () => {
  it('retains only portable coverage facts and independently accounts for every current file', () => {
    const f = fixture(),
      verified = verifyNativeShardReceipts(f.receipts, f.input);
    expect(verified.coverage).toEqual({ shards: 3, testFiles: 3, total: 3, passed: 3, skipped: 0 });
    expect(
      f.receipts.flatMap((r) => r.report.files).every((p) => /^(apps|packages)\//u.test(p)),
    ).toBe(true);
    expect(JSON.stringify(f.receipts)).not.toContain(process.cwd().replaceAll('\\', '/'));
    expect(Object.keys(f.receipts[0]!.report).sort()).toEqual([
      'failed',
      'files',
      'passed',
      'skipped',
      'success',
      'total',
    ]);
  });
  it('rejects cross-head, cross-run, future, different-inventory and different-dispatch evidence', () => {
    const f = fixture();
    for (const change of [
      { source: { ...f.input.source, headSha: 'b'.repeat(40) } },
      { source: { ...f.input.source, runId: '456' } },
      { source: { ...f.input.source, attempt: 2 } },
      { fileInventorySha256: 'd'.repeat(64) },
      { durationInventorySha256: 'e'.repeat(64) },
      { schemaVersion: 2 },
    ]) {
      expect(() =>
        verifyNativeShardReceipts(
          [{ ...f.receipts[0], ...change }, ...f.receipts.slice(1)],
          f.input,
        ),
      ).toThrow('coverage');
    }
  });
  it('requires exactly all three current partitions and rejects overlap, omissions and misplaced files', () => {
    const f = fixture(2);
    for (const values of [
      f.receipts.slice(0, 2),
      [...f.receipts, f.receipts[0]],
      f.receipts.map((r, i) =>
        i === 0 ? { ...r, report: { ...r.report, files: f.receipts[1]!.report.files } } : r,
      ),
      f.receipts.map((r, i) => (i === 0 ? { ...r, report: { ...r.report, files: [] } } : r)),
    ])
      expect(() => verifyNativeShardReceipts(values, f.input)).toThrow('coverage');
    expect(() => verifyNativeShardReceipts(f.receipts, { ...f.input, minimumTests: 4 })).toThrow(
      'coverage',
    );
  });
  it('never accepts failure, skipped cases, inconsistent or nonfinite counts', () => {
    const f = fixture();
    for (const change of [
      { success: false },
      { failed: 1 },
      { skipped: 1 },
      { passed: 0 },
      { total: 2 },
      { total: NaN },
      { passed: Infinity },
    ]) {
      const values = f.receipts.map((r, i) =>
        i === 0 ? { ...r, report: { ...r.report, ...change } } : r,
      );
      expect(() => verifyNativeShardReceipts(values, f.input)).toThrow('coverage');
    }
  });
  it('rejects private fields and unsafe paths rather than copying them to an artifact', () => {
    const f = fixture();
    for (const changed of [
      { ...f.receipts[0], privateAssertion: 'private provider URL' },
      { ...f.receipts[0], report: { ...f.receipts[0]!.report, assertions: 'private text' } },
      ...[
        '../outside.integration.test.ts',
        'apps/../outside.integration.test.ts',
        '/absolute.integration.test.ts',
        'apps\\unsafe.integration.test.ts',
      ].map((file) => ({ ...f.receipts[0], report: { ...f.receipts[0]!.report, files: [file] } })),
    ])
      expect(() => verifyNativeShardReceipts([changed, ...f.receipts.slice(1)], f.input)).toThrow(
        'coverage',
      );
  });
  it('uses the newest successful proof per partition only within the same unchanged workflow run', () => {
    const old = fixture(),
      fresh = fixture(2);
    const verified = verifyNativeShardReceipts([...old.receipts, fresh.receipts[0]!], fresh.input);
    expect(verified.receipts.map((r) => r.source.attempt)).toEqual([2, 1, 1]);
    expect(() =>
      verifyNativeShardReceipts(
        [
          ...old.receipts,
          { ...fresh.receipts[0], source: { ...fresh.input.source, runId: '999' } },
        ],
        fresh.input,
      ),
    ).toThrow('coverage');
  });
  it('refuses creation of a supposedly successful shard if its actual file selection or count is incomplete', () => {
    const f = fixture(),
      base = {
        ...f.input,
        shard: 1 as const,
        report: {
          success: true,
          total: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          files: f.input.dispatch.files[0]!,
        },
      };
    for (const report of [
      { ...base.report, files: [] },
      { ...base.report, passed: 0 },
      { ...base.report, skipped: 1 },
    ])
      expect(() => createNativeShardReceipt({ ...base, report })).toThrow('coverage');
  });
});
