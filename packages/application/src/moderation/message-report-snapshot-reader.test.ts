import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IntegrityMessageReportSnapshotReader,
  type StoredMessageReportSnapshot,
} from './message-report-snapshot-reader.js';

const subject = { reportId: randomUUID(), chatSessionId: randomUUID(), messageId: randomUUID() };
const reader = new IntegrityMessageReportSnapshotReader();
function captured(
  messageType: StoredMessageReportSnapshot['messageType'],
  content: unknown,
): StoredMessageReportSnapshot {
  const data = {
    reportId: subject.reportId,
    chatSessionId: subject.chatSessionId,
    originalMessageId: subject.messageId,
    senderUserId: randomUUID(),
    messageType,
    content,
    originalCreatedAt: new Date('2026-10-03T10:00:00.123Z'),
  };
  return {
    ...data,
    integritySha256: createHash('sha256')
      .update(JSON.stringify({ ...data, originalCreatedAt: data.originalCreatedAt.toISOString() }))
      .digest('hex'),
  };
}
describe('M6 message integrity reader', () => {
  it('projects all four message types without sender or session identity', () => {
    for (const [type, content] of [
      ['text', { text: 'Retained private text' }],
      ['predefined_question', { predefinedQuestionId: randomUUID() }],
      ['predefined_answer', { predefinedAnswerId: randomUUID() }],
      ['system', { localizationKey: 'chat.closed', arguments: { reason: 'unmatched' } }],
    ] as const) {
      const snapshot = captured(type, content),
        result = reader.read(subject, snapshot);
      expect(result).toEqual({
        evidenceType: 'message',
        messageId: subject.messageId,
        messageType: type,
        content: type === 'text' ? 'Retained private text' : JSON.stringify(content),
        createdAt: snapshot.originalCreatedAt.toISOString(),
      });
      expect(JSON.stringify(result)).not.toContain(snapshot.senderUserId!);
      expect(JSON.stringify(result)).not.toContain(subject.chatSessionId);
    }
  });
  it('reconstructs content key order after JSONB storage while preserving argument order', () => {
    const snapshot = captured('system', {
      localizationKey: 'chat.closed',
      arguments: { a: 'one', longKey: 'two' },
    });
    expect(
      reader.read(subject, {
        ...snapshot,
        content: { arguments: { a: 'one', longKey: 'two' }, localizationKey: 'chat.closed' },
      }).messageType,
    ).toBe('system');
  });
  it('rejects tampering in every digest-bound field and mismatched subjects', () => {
    const snapshot = captured('text', { text: 'Private text' });
    for (const change of [
      { reportId: randomUUID() },
      { chatSessionId: randomUUID() },
      { originalMessageId: randomUUID() },
      { senderUserId: randomUUID() },
      { content: { text: 'Changed private text' } },
      { originalCreatedAt: new Date() },
      { integritySha256: '0'.repeat(64) },
      { integritySha256: 'invalid' },
      { originalCreatedAt: new Date('invalid') },
    ])
      expect(() => reader.read(subject, { ...snapshot, ...change })).toThrow(
        'Report snapshot could not be read.',
      );
    expect(() => reader.read({ ...subject, messageId: randomUUID() }, snapshot)).toThrow(
      'Report snapshot could not be read.',
    );
  });
  it('rejects malformed or extra content even with a matching digest and never returns raw errors', () => {
    for (const snapshot of [
      captured('text', { text: 'private', sender: randomUUID() }),
      captured('text', { text: '' }),
      captured('text', { text: 'x'.repeat(1001) }),
      captured('predefined_question', { predefinedQuestionId: 'invalid' }),
      captured('system', { localizationKey: 'private', arguments: { value: 1 } }),
      captured('system', { localizationKey: 'private', arguments: Array(2).fill('private') }),
    ])
      expect(() => reader.read(subject, snapshot)).toThrow('Report snapshot could not be read.');
  });
});
