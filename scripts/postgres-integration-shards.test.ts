import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  integrationShardEnvironment,
  planIntegrationShards,
  parseIntegrationShardReport,
  verifyIntegrationShardCoverage,
  type IntegrationShardReport,
} from './postgres-integration-shards.js';

const first = resolve('packages/one.integration.test.ts');
const second = resolve('apps/two.integration.test.ts');
const third = resolve('packages/three.integration.test.ts');
function report(file: string, total = 1): IntegrationShardReport {
  return { success: true, total, passed: total, failed: 0, skipped: 0, files: [file] };
}

describe('complete isolated native integration shards', () => {
  it('dispatches every file exactly once with deterministic bounded load imbalance', () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      resolve(`packages/dispatch-${index}.integration.test.ts`),
    );
    const durations = Object.fromEntries(
      files.map((_file, index) => [
        `packages/dispatch-${index}.integration.test.ts`,
        ((index * 7919) % 100000) + 1,
      ]),
    );
    const plan = planIntegrationShards(files, durations);
    expect(planIntegrationShards([...files].reverse(), durations)).toEqual(plan);
    expect(new Set(plan.files.flat())).toEqual(new Set(files));
    expect(plan.files.flat()).toHaveLength(files.length);
    expect(Math.max(...plan.estimatedMs) - Math.min(...plan.estimatedMs)).toBeLessThanOrEqual(
      Math.max(...Object.values(durations)),
    );
    expect(plan.files.every((shard) => shard.length > 0)).toBe(true);
  });

  it('executes unmeasured suites and keeps duration estimates out of coverage authority', () => {
    const plan = planIntegrationShards([first, second, third], {});
    expect(plan.files.flat().sort()).toEqual([first, second, third].sort());
    expect(plan.estimatedMs).toEqual([30000, 30000, 30000]);
    expect(() =>
      verifyIntegrationShardCoverage(
        [
          report(plan.files[0]![0]!),
          report(plan.files[1]![0]!),
          { ...report(plan.files[2]![0]!), skipped: 1 },
        ],
        [first, second, third],
        2,
      ),
    ).toThrow('coverage');
  });

  it('rejects malformed scheduling input rather than dropping or duplicating native suites', () => {
    for (const files of [
      [],
      [first],
      [first, second],
      [first, first, second],
      [first, second, resolve('../outside.integration.test.ts')],
    ])
      expect(() => planIntegrationShards(files, {})).toThrow('coverage');
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => planIntegrationShards([first, second, third], { [first]: value })).toThrow(
        'coverage',
      );
  });

  it('separates the longest suites so a filename partition cannot strand all heavy work together', () => {
    const files = ['largest', 'second', 'third', 'small'].map((name) =>
      resolve(`packages/${name}.integration.test.ts`),
    );
    const weights = {
      'packages/largest.integration.test.ts': 300000,
      'packages/second.integration.test.ts': 220000,
      'packages/third.integration.test.ts': 200000,
      'packages/small.integration.test.ts': 10000,
    };
    const plan = planIntegrationShards(files, weights);
    expect(plan.files.find((group) => group.includes(files[0]!))).not.toContain(files[1]!);
    expect(plan.estimatedMs.reduce((sum, value) => sum + value, 0)).toBe(730000);
    expect(plan.files.flat()).toHaveLength(4);
  });

  it('retains every declared file exactly once and accounts for every passed test', () => {
    expect(
      verifyIntegrationShardCoverage(
        [report(first, 471), report(second, 469), report(third)],
        [first, second, third],
        941,
      ),
    ).toEqual({ shards: 3, testFiles: 3, total: 941, passed: 941, skipped: 0 });
  });

  it('denies an apparently green partial run and duplicate or unexpected files', () => {
    for (const reports of [
      [report(first), report(second), { ...report(third), files: [] }],
      [report(first), report(second), report(second)],
      [report(first), report(second), report(resolve('apps/unexpected.integration.test.ts'))],
    ])
      expect(() => verifyIntegrationShardCoverage(reports, [first, second, third], 3)).toThrow(
        'coverage',
      );
    expect(() =>
      verifyIntegrationShardCoverage(
        [report(first), report(second), report(third)],
        [first, second, third],
        941,
      ),
    ).toThrow('coverage');
  });

  it('never authorizes later gates after a failed or skipped case', () => {
    for (const changed of [{ success: false }, { failed: 1 }, { skipped: 1 }, { passed: 0 }])
      expect(() =>
        verifyIntegrationShardCoverage(
          [report(first), report(second), { ...report(third), ...changed }],
          [first, second, third],
          2,
        ),
      ).toThrow('coverage');
  });

  it('requires exactly all three native reports before authorizing later gates', () => {
    for (const reports of [
      [report(first), report(second)],
      [
        report(first),
        report(second),
        report(third),
        report(resolve('packages/four.integration.test.ts')),
      ],
    ])
      expect(() => verifyIntegrationShardCoverage(reports, [first, second, third], 3)).toThrow(
        'coverage',
      );
  });

  it('accepts only internally consistent finite JSON coverage facts', () => {
    const input = {
      success: true,
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [{ name: first }],
      privateAssertion: 'not retained',
    };
    expect(parseIntegrationShardReport(input)).toEqual(report(first, 3));
    for (const changed of [
      { numPassedTests: 2 },
      { numTotalTests: -1 },
      { numTotalTests: Number.NaN },
      { success: 'true' },
      { testResults: [{}] },
    ])
      expect(() => parseIntegrationShardReport({ ...input, ...changed })).toThrow('coverage');
  });

  it('keeps simultaneous PostgreSQL and Redis contexts physically distinct', () => {
    const original = {
      NAKH_TEST_DATABASE_URL: 'postgresql://test:private@localhost/base',
      NAKH_DATABASE_URL: 'postgresql://test:private@localhost/base',
      NAKH_TEST_REDIS_URL: 'redis://:private@localhost/0',
      PGDATABASE: 'base',
    };
    const one = integrationShardEnvironment(original, 'postgresql://test:private@localhost/one', 1);
    const two = integrationShardEnvironment(original, 'postgresql://test:private@localhost/two', 2);
    const three = integrationShardEnvironment(
      original,
      'postgresql://test:private@localhost/three',
      3,
    );
    expect(new Set([one.PGDATABASE, two.PGDATABASE, three.PGDATABASE]).size).toBe(3);
    expect(three.PGDATABASE).toBe('three');
    expect(new URL(three.NAKH_TEST_REDIS_URL!).pathname).toBe('/3');
    expect(three.NAKH_DATABASE_URL).toBe(three.NAKH_TEST_DATABASE_URL);
    expect(one.PGDATABASE).toBe('one');
    expect(two.PGDATABASE).toBe('two');
    expect(one.NAKH_DATABASE_URL).toBe(one.NAKH_TEST_DATABASE_URL);
    expect(two.NAKH_DATABASE_URL).toBe(two.NAKH_TEST_DATABASE_URL);
    expect(new URL(one.NAKH_TEST_REDIS_URL!).pathname).toBe('/1');
    expect(new URL(two.NAKH_TEST_REDIS_URL!).pathname).toBe('/2');
    expect(one.NAKH_REDIS_URL).toBe(one.NAKH_TEST_REDIS_URL);
    expect(original.PGDATABASE).toBe('base');
    expect(new URL(original.NAKH_TEST_REDIS_URL).pathname).toBe('/0');
  });

  it('denies invalid provider protocols and Redis ranges rather than sharing state', () => {
    expect(() => integrationShardEnvironment({}, 'https://localhost/base', 1)).toThrow('coverage');
    for (const url of [
      'https://localhost/0',
      'redis://localhost/12',
      'redis://localhost/13',
      'redis://localhost/14',
      'redis://localhost/not-a-db',
    ])
      expect(() =>
        integrationShardEnvironment({ NAKH_TEST_REDIS_URL: url }, 'postgresql://localhost/test', 2),
      ).toThrow('coverage');
  });

  it('keeps every shard outside the composed fixture database even at the maximum Redis base', () => {
    const paths = ([1, 2, 3] as const).map(
      (shard) =>
        new URL(
          integrationShardEnvironment(
            { NAKH_TEST_REDIS_URL: 'redis://localhost/11' },
            `postgresql://localhost/worker_${shard}`,
            shard,
          ).NAKH_TEST_REDIS_URL!,
        ).pathname,
    );
    expect(paths).toEqual(['/12', '/13', '/14']);
    expect(new Set(paths).size).toBe(3);
    expect(paths).not.toContain('/15');
    expect(() =>
      integrationShardEnvironment({}, 'postgresql://localhost/test', 4 as never),
    ).toThrow('coverage');
  });
});
