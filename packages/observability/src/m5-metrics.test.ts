import { describe, expect, it } from 'vitest';

import {
  M5_ACTION_OUTCOMES,
  M5_CREATION_OUTCOMES,
  M5_DELIVERY_OUTCOMES,
  M5_FUNDING_TYPES,
  M5_MAINTENANCE_OPERATIONS,
  M5_METRIC_LABEL_KEYS,
  M5_RECEIVER_ACTIONS,
  M5_RECONCILIATION_OUTCOMES,
  M5_RECONCILIATION_PHASES,
  M5_SETTLEMENT_STOP_REASONS,
  M5Metrics,
} from './m5-metrics.js';

describe('M5 metric contract', () => {
  it('locks all metric dimensions to finite privacy-safe registries', () => {
    expect(M5_FUNDING_TYPES).toEqual(['credits', 'telegram_stars']);
    expect(M5_CREATION_OUTCOMES).toContain('replayed');
    expect(M5_DELIVERY_OUTCOMES).toContain('correction_required');
    expect(M5_SETTLEMENT_STOP_REASONS).toContain('external_funding');
    expect(M5_MAINTENANCE_OPERATIONS).toContain('pending_expiry');
    expect(M5_RECEIVER_ACTIONS).toEqual(['view', 'accept', 'reject']);
    expect(M5_ACTION_OUTCOMES).toContain('closed');
    expect(M5_RECONCILIATION_PHASES).toEqual([
      'flows',
      'counters',
      'pending',
      'delivered',
      'unknown',
    ]);
    expect(M5_RECONCILIATION_OUTCOMES).toEqual(['in_progress', 'completed', 'failure']);
    expect(M5_METRIC_LABEL_KEYS).not.toEqual(
      expect.arrayContaining([
        'user_id',
        'nakh_id',
        'payment_id',
        'provider_id',
        'text',
        'locale',
        'balance',
        'error',
      ]),
    );
  });

  it('records each M5 operation and health signal without identity dimensions', () => {
    const metrics = new M5Metrics();
    expect(() => {
      metrics.recordCreation('created', 'credits', 5);
      metrics.recordDelivery('delivered', 'telegram_stars', 20);
      metrics.recordSettlement('queue_empty', 50, 4, 1);
      metrics.recordMaintenance('pending_expiry', 'completed', 30, 10, 2);
      metrics.recordMaintenance('batch', 'failure', 30);
      metrics.recordReceiverAction('accept', 'completed', 15);
      metrics.recordOperationalHealth({
        settlementBacklogCount: 10,
        settlementOldestAgeSeconds: 60,
        paidUndeliveredCount: 1,
        paidUndeliveredOldestAgeSeconds: 5,
        quotaDriftCount: 0,
        fundingInvariantMismatchCount: 0,
      });
      metrics.recordOperationalHealthFailure();
      metrics.recordReconciliation('in_progress', 'pending', 40, 100, 2);
      metrics.recordReconciliation('failure', 'unknown', 40);
      metrics.recordCallbackConflict();
    }).not.toThrow();
  });
});
