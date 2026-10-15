import { describe, expect, it } from 'vitest';
import { classifyDeletionEvent } from './deletion-event-policy.js';

const id = '10000000-0000-4000-8000-000000000001';
describe('M8 typed operational event disposition', () => {
  it('classifies only the exact content-free Return transport shape without granting restoration authority', () => {
    const payload = { userId: id, accountVersion: 3 };
    expect(classifyDeletionEvent('account.returned.v1', 1, payload)).toBe('lifecycle_proof');
    for (const invalid of [
      { ...payload, profileSnapshot: 'private' },
      { ...payload, productEpoch: 1 },
      { ...payload, approvalId: id },
      { ...payload, accountVersion: -1 },
      { ...payload, accountVersion: 1.5 },
      { ...payload, userId: 'invalid' },
      { userId: id },
    ])
      expect(classifyDeletionEvent('account.returned.v1', 1, invalid)).toBe('unclassified');
    expect(classifyDeletionEvent('account.returned.v1', 2, payload)).toBe('unclassified');
  });
  it.each([
    [
      'telegram.start-route-requested.v1',
      { userId: id, entryRoute: 'guest', uiLocale: 'en' },
      'product_transport',
    ],
    [
      'profile.confirmed.v1',
      { userId: id, profileId: id, accountState: 'active' },
      'product_transport',
    ],
    [
      'identity.account-state-changed.v1',
      { userId: id, profileId: id, accountState: 'active' },
      'product_transport',
    ],
    [
      'identity.account-state-changed.v1',
      {
        userId: id,
        previousState: 'active',
        nextState: 'restricted',
        reasonCode: 'distinct_reporter_threshold',
        accountVersion: 2,
      },
      'product_transport',
    ],
    [
      'chat.message-created.v1',
      { chatSessionId: id, messageId: id, messageType: 'text' },
      'product_transport',
    ],
    [
      'matching.match-created.v1',
      { matchId: id, userLowId: id, userHighId: id, source: 'mutual_like' },
      'product_transport',
    ],
    [
      'nakh.status-changed.v1',
      { pendingNakhId: id, status: 'closed_by_system' },
      'product_transport',
    ],
    [
      'billing.payment-corrected.v1',
      { paymentRecordId: id, refundRecordId: id },
      'financial_proof',
    ],
    [
      'billing.credit-increased.v1',
      { creditTransactionId: id, amount: '9223372036854775807', balanceAfter: '0' },
      'financial_proof',
    ],
    [
      'moderation.report-submitted.v1',
      { reportId: id, evidenceTypes: ['profile', 'photo'], status: 'submitted' },
      'safety_proof',
    ],
    [
      'support.thread-changed.v1',
      { supportThreadId: id, userId: id, status: 'closed', version: 2, unansweredUserMessages: 0 },
      'safety_proof',
    ],
    [
      'account.deletion-notice-batch.v1',
      { deletionRecordId: id, kind: 'notice_source', rows: 1, auditId: id },
      'lifecycle_proof',
    ],
    [
      'account.deletion-phase-completed.v1',
      {
        deletionRecordId: id,
        completedPhase: 'product_data',
        nextPhase: 'media_objects',
        checkpointVersion: 4,
      },
      'lifecycle_proof',
    ],
    [
      'platform.sample-effect-created.v1',
      { effectId: id, name: 'Private test product text' },
      'ordinary_content',
    ],
  ] as const)(
    'classifies %s without returning payload or restoration authority',
    (type, payload, expected) => {
      expect(classifyDeletionEvent(type, 1, payload)).toBe(expected);
    },
  );
  it.each([
    'text',
    'body',
    'name',
    'notes',
    'telegramUserId',
    'nonce',
    'ciphertext',
    'profileSnapshot',
  ])('does not bless added %s even under a known content-free event name', (key) => {
    expect(
      classifyDeletionEvent('chat.message-created.v1', 1, {
        chatSessionId: id,
        messageId: id,
        messageType: 'text',
        [key]: 'Private material',
      }),
    ).toBe('unclassified');
  });
  it.each([
    null,
    [],
    'private text',
    123,
    { paymentRecordId: 'private text' },
    { paymentRecordId: id, extra: id },
  ])(
    'rejects malformed or unreviewed financial transport instead of retaining it as financial proof',
    (payload) => {
      expect(classifyDeletionEvent('billing.payment-fulfilled.v1', 1, payload)).toBe(
        'unclassified',
      );
    },
  );
  it('denies unknown types and schema versions rather than guessing from a prefix', () => {
    expect(classifyDeletionEvent('billing.new-producer.v1', 1, { paymentRecordId: id })).toBe(
      'unclassified',
    );
    expect(classifyDeletionEvent('billing.payment-fulfilled.v1', 2, { paymentRecordId: id })).toBe(
      'unclassified',
    );
    expect(classifyDeletionEvent('toString', 1, {})).toBe('unclassified');
  });
  it('requires one original Nakh or Like identity and rejects missing or ambiguous source bindings', () => {
    for (const payload of [{ status: 'sent' }, { status: 'sent', nakhId: id, pendingNakhId: id }])
      expect(classifyDeletionEvent('nakh.status-changed.v1', 1, payload)).toBe('unclassified');
    for (const payload of [{ reason: 'matched' }, { reason: 'matched', likeId: id, likeIds: [id] }])
      expect(classifyDeletionEvent('interaction.like-closed.v1', 1, payload)).toBe('unclassified');
  });
  it('does not accept inherited fields, arbitrary enum prose, nested snapshots or unsafe counters', () => {
    expect(
      classifyDeletionEvent(
        'billing.payment-fulfilled.v1',
        1,
        Object.create({ paymentRecordId: id }),
      ),
    ).toBe('unclassified');
    for (const messageType of ['Private message body', { text: 'private' }])
      expect(
        classifyDeletionEvent('chat.message-created.v1', 1, {
          chatSessionId: id,
          messageId: id,
          messageType,
        }),
      ).toBe('unclassified');
    for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER, '1'])
      expect(
        classifyDeletionEvent('profile.updated.v1', 1, { userId: id, profileId: id, version }),
      ).toBe('unclassified');
  });
});
