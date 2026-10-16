import { describe, expect, it } from 'vitest';
import { summarizeM7Plan, m7PlanPasses } from './m7-plan-evidence.js';
describe('M7 plan evidence privacy', () => {
  it('accepts either authoritative appeal queue index and rejects unindexed or slow plans', () => {
    const permitted = ['user_appeals_queue_idx', 'user_appeals_status_submitted_idx'];
    for (const index of permitted)
      expect(m7PlanPasses({ executionMs: 1, actualRows: 51, indexNames: [index] }, permitted)).toBe(
        true,
      );
    expect(m7PlanPasses({ executionMs: 1, actualRows: 51, indexNames: [] }, permitted)).toBe(false);
    expect(
      m7PlanPasses({ executionMs: 1501, actualRows: 51, indexNames: permitted }, permitted),
    ).toBe(false);
  });
  it('drops predicates, SQL, private identifiers, prose and unknown fields recursively', () => {
    const result = summarizeM7Plan([
      {
        'Execution Time': 1.2,
        Query: 'private text',
        JIT: {
          Functions: 3,
          Options: {
            Expressions: true,
            Deforming: false,
            Inlining: true,
            Optimization: false,
            Private: 'private option',
          },
          Timing: {
            Generation: 0.1,
            Inlining: 0.05,
            Optimization: 0.05,
            Emission: 0.35,
            Total: 0.55,
            Query: 'private JIT text',
          },
        },
        Plan: {
          'Actual Rows': 51,
          'Index Cond': 'user_id = private-user',
          Alias: 'private alias',
          Output: ['private appeal text'],
          'Temp Read Blocks': 3,
          'Temp Written Blocks': 4,
          Plans: [
            {
              'Index Name': 'support_threads_status_created_idx',
              Filter: 'private-ban',
              'Hash Batches': 8,
              'Actual Loops': 20000,
              'Node Type': 'Index Scan',
              'Relation Name': 'private-user',
              'Actual Total Time': 0.002,
              'Workers Planned': 2,
              'Workers Launched': 1,
              'Sort Space Type': 'Disk',
              'Sort Space Used': 32,
              'Temp Read Blocks': 3,
              'Temp Written Blocks': 4,
            },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      executionMs: 1.2,
      actualRows: 51,
      indexNames: ['support_threads_status_created_idx'],
      diagnostics: {
        tempReadBlocks: 3,
        tempWrittenBlocks: 4,
        maximumHashBatches: 8,
        diskSortKb: 32,
        maximumLoops: 20000,
        maximumWorkersPlanned: 2,
        maximumWorkersLaunched: 1,
        jitTotalMs: 0.55,
        jitFunctions: 3,
        jitGenerationMs: 0.1,
        jitInliningMs: 0.05,
        jitOptimizationMs: 0.05,
        jitEmissionMs: 0.35,
        jitExpressions: true,
        jitDeforming: false,
        jitInlining: true,
        jitOptimization: false,
        nodes: [
          { parent: -1, nodeType: 'Other', relation: 'Other', rows: 51, loops: 0, totalMs: 0 },
          {
            parent: 0,
            nodeType: 'Index Scan',
            relation: 'Other',
            rows: 0,
            loops: 20000,
            totalMs: 0.002,
          },
        ],
        nodesTruncated: false,
        slowNodes: [
          {
            nodeType: 'Index Scan',
            relation: 'Other',
            totalMs: 0.002,
            loops: 20000,
            cumulativeMs: 40,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(() =>
      summarizeM7Plan([{ 'Execution Time': Number.NaN, Plan: { 'Actual Rows': 1 } }]),
    ).toThrow('M7 query plan unavailable');
  });
  it('drops malformed compilation counters and nonboolean options', () => {
    const result = summarizeM7Plan([
      {
        'Execution Time': 1,
        Plan: { 'Actual Rows': 1 },
        JIT: {
          Functions: Number.NaN,
          Options: { Expressions: 'private', Deforming: 1 },
          Timing: {
            Generation: -1,
            Optimization: Number.POSITIVE_INFINITY,
            Emission: 'private',
            Total: 2,
          },
        },
      },
    ]);
    expect(result.diagnostics).toMatchObject({
      jitTotalMs: 2,
      jitFunctions: 0,
      jitGenerationMs: 0,
      jitOptimizationMs: 0,
      jitEmissionMs: 0,
      jitExpressions: false,
      jitDeforming: false,
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('accepts nested generation totals without exposing deforming details or unknown fields', () => {
    const result = summarizeM7Plan([
      {
        'Execution Time': 2,
        Plan: { 'Actual Rows': 10 },
        JIT: { Timing: { Generation: { Total: 0.75, Deform: 0.2, Query: 'private generation' } } },
      },
    ]);
    expect(result.diagnostics.jitGenerationMs).toBe(0.75);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('"Deform":');
  });
});
