import { describe, expect, it } from 'vitest';
import { retentionPolicyRequestDigest, type RetentionPolicyChange } from './retention-policy.js';

const root = '11111111-1111-4111-8111-111111111111';
const policy = {
  resource: 'support.support_messages',
  retentionSeconds: 86400,
  basis: 'deletion_completed_at' as const,
  evidenceHash: 'a'.repeat(64),
  expectedPolicyVersion: 0,
};
const approval: RetentionPolicyChange = { action: 'approve', policy };
describe('retention policy command binding', () => {
  it('binds the original Root, version, resource, period, evidence and revision', () => {
    const digest = retentionPolicyRequestDigest(root, 1, approval);
    const variants: RetentionPolicyChange[] = [
      { action: 'approve', policy: { ...policy, resource: 'support.support_threads' } },
      { action: 'approve', policy: { ...policy, retentionSeconds: 86401 } },
      { action: 'approve', policy: { ...policy, evidenceHash: 'b'.repeat(64) } },
      { action: 'approve', policy: { ...policy, expectedPolicyVersion: 1 } },
      { action: 'revoke', approvalId: root },
    ];
    for (const value of variants)
      expect(retentionPolicyRequestDigest(root, 1, value)).not.toBe(digest);
    expect(retentionPolicyRequestDigest(root, 2, approval)).not.toBe(digest);
    expect(retentionPolicyRequestDigest(root.replace(/^1/u, '2'), 1, approval)).not.toBe(digest);
    expect(
      retentionPolicyRequestDigest(root, 1, { action: 'approve', policy: { ...policy } }),
    ).toBe(digest);
  });
  it('requires an explicit bounded integer period and never supplies a default', () => {
    for (const retentionSeconds of [undefined, 0, -1, 0.5, NaN, Infinity, 3155760001])
      expect(() =>
        retentionPolicyRequestDigest(root, 1, {
          action: 'approve',
          policy: { ...policy, retentionSeconds: retentionSeconds as number },
        }),
      ).toThrow();
    expect(() =>
      retentionPolicyRequestDigest(root, 1, {
        action: 'approve',
        policy: { ...policy, retentionSeconds: 3155760000 },
      }),
    ).not.toThrow();
  });
  it('rejects arbitrary SQL, prose, ambiguous bases and malformed revision or evidence', () => {
    for (const fields of [
      { resource: 'support.support_messages; DELETE' },
      { resource: 'a'.repeat(129) },
      { basis: 'created_at' },
      { evidenceHash: 'approved by someone' },
      { expectedPolicyVersion: -1 },
      { expectedPolicyVersion: 0.1 },
      { expectedPolicyVersion: 2147483647 },
    ])
      expect(() =>
        retentionPolicyRequestDigest(root, 1, {
          action: 'approve',
          policy: { ...policy, ...fields } as typeof policy,
        }),
      ).toThrow();
    expect(() =>
      retentionPolicyRequestDigest(root, 1, { action: 'revoke', approvalId: 'borrowed prose' }),
    ).toThrow();
  });
});
