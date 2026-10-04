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
        Plan: {
          'Actual Rows': 51,
          'Index Cond': 'user_id = private-user',
          Output: ['private appeal text'],
          Plans: [{ 'Index Name': 'support_threads_status_created_idx', Filter: 'private-ban' }],
        },
      },
    ]);
    expect(result).toEqual({
      executionMs: 1.2,
      actualRows: 51,
      indexNames: ['support_threads_status_created_idx'],
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(() =>
      summarizeM7Plan([{ 'Execution Time': Number.NaN, Plan: { 'Actual Rows': 1 } }]),
    ).toThrow('M7 query plan unavailable');
  });
});
