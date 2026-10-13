import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  integrationShardEnvironment,
  parseIntegrationShardReport,
  verifyIntegrationShardCoverage,
  type IntegrationShardReport,
} from './postgres-integration-shards.js';

const first = resolve('packages/one.integration.test.ts');
const second = resolve('apps/two.integration.test.ts');
function report(file: string, total = 1): IntegrationShardReport {
  return { success: true, total, passed: total, failed: 0, skipped: 0, files: [file] };
}

describe('complete isolated native integration shards', () => {
  it('retains every declared file exactly once and accounts for every passed test', () => {
    expect(
      verifyIntegrationShardCoverage(
        [report(first, 472), report(second, 469)],
        [first, second],
        941,
      ),
    ).toEqual({ shards: 2, testFiles: 2, total: 941, passed: 941, skipped: 0 });
  });

  it('denies an apparently green partial run and duplicate or unexpected files', () => {
    for (const reports of [
      [report(first), { ...report(second), files: [] }],
      [report(first), report(first)],
      [report(first), report(resolve('apps/unexpected.integration.test.ts'))],
    ])
      expect(() => verifyIntegrationShardCoverage(reports, [first, second], 2)).toThrow('coverage');
    expect(() =>
      verifyIntegrationShardCoverage([report(first), report(second)], [first, second], 941),
    ).toThrow('coverage');
  });

  it('never authorizes later gates after a failed or skipped case', () => {
    for (const changed of [{ success: false }, { failed: 1 }, { skipped: 1 }, { passed: 0 }])
      expect(() =>
        verifyIntegrationShardCoverage(
          [report(first), { ...report(second), ...changed }],
          [first, second],
          2,
        ),
      ).toThrow('coverage');
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
    for (const url of ['https://localhost/0', 'redis://localhost/14', 'redis://localhost/not-a-db'])
      expect(() =>
        integrationShardEnvironment({ NAKH_TEST_REDIS_URL: url }, 'postgresql://localhost/test', 2),
      ).toThrow('coverage');
  });
});
