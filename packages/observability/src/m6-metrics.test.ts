import { describe, expect, it } from 'vitest';

import {
  M6_AUTHORIZATION_DENIALS,
  M6_CLEANUP_OUTCOMES,
  M6_DELIVERY_OUTCOMES,
  M6_METRIC_LABEL_KEYS,
  M6_RECONCILIATION_OUTCOMES,
  M6_RECONCILIATION_PHASES,
  M6_RETRY_CLASSES,
  M6_SEND_KINDS,
  M6_SEND_OUTCOMES,
  M6_UNMATCH_OUTCOMES,
  M6Metrics,
  m6RetryClass,
} from './m6-metrics.js';

describe('M6 metric contract', () => {
  it('locks every dimension to a finite privacy-safe registry', () => {
    expect(M6_SEND_KINDS).toEqual(['predefined_question', 'predefined_answer', 'text', 'system']);
    expect(M6_SEND_OUTCOMES).toContain('denied');
    expect(M6_AUTHORIZATION_DENIALS).toContain('capability_denied');
    expect(M6_DELIVERY_OUTCOMES).toContain('quarantined');
    expect(M6_RETRY_CLASSES).toContain('ambiguous');
    expect(M6_CLEANUP_OUTCOMES).toEqual(['completed', 'failure']);
    expect(M6_RECONCILIATION_PHASES).toEqual([
      'sessions',
      'messages',
      'unmatches',
      'deliveries',
      'unknown',
    ]);
    expect(M6_RECONCILIATION_OUTCOMES).toEqual(['in_progress', 'completed', 'failure']);
    expect(M6_UNMATCH_OUTCOMES).toContain('replayed');
    expect(M6_METRIC_LABEL_KEYS).not.toEqual(
      expect.arrayContaining([
        'user_id',
        'session_id',
        'message_id',
        'provider_id',
        'reason_code',
        'text',
        'locale',
        'error',
      ]),
    );
  });

  it('records M6 operations and aggregate health without identity dimensions', () => {
    const metrics = new M6Metrics();
    expect(() => {
      metrics.recordSend('text', 'sent', 5);
      metrics.recordAuthorizationDenial('capability_denied');
      metrics.recordDelivery('retry_scheduled', 'rate_limited', 20);
      metrics.recordCleanup('completed', 30, 2, 10, 1);
      metrics.recordReconciliation('in_progress', 'sessions', 40, 100, 2);
      metrics.recordUnmatch('completed');
      metrics.recordOperationalHealth({
        dueDeliveryCount: 1,
        dueDeliveryOldestAgeSeconds: 5,
        expiredCallLeaseCount: 0,
        expiredCallLeaseOldestAgeSeconds: 0,
        cleanupBacklogSessionCount: 2,
        cleanupBacklogMessageCount: 10,
        cleanupBacklogOldestAgeSeconds: 60,
        pendingSnapshotCount: 1,
        pendingSnapshotOldestAgeSeconds: 10,
        participantMismatchCount: 0,
        sequenceIntegrityCount: 0,
        deliveryIntegrityCount: 0,
      });
      metrics.recordOperationalHealthFailure();
    }).not.toThrow();
    expect(m6RetryClass('bot_blocked')).toBe('terminal');
    expect(m6RetryClass('unsafe-provider-detail')).toBe('transient');
  });
});
