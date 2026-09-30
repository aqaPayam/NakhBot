import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  chatReportSnapshotAad,
  isReportChatContent,
} from './chat-report-snapshot.js';
import { AesGcmProfileReportSnapshotReader } from './profile-report-snapshot-reader.js';
const subject = { reportId: randomUUID(), evidenceId: randomUUID() },
  key = Buffer.alloc(32, 71);
const content = {
  evidenceType: 'chat' as const,
  chatSessionId: randomUUID(),
  status: 'active' as const,
};
describe('minimal encrypted chat evidence', () => {
  it('round trips lifecycle-only content with unique nonces and historical key identity', () => {
    const protector = new AesGcmChatReportSnapshotProtector('chat-key', 2, key);
    const resolve = vi.fn((id: string, version: number) =>
      id === 'chat-key' && version === 2 ? key : undefined,
    );
    const reader = new AesGcmChatReportSnapshotReader({ resolve });
    const first = protector.protect(subject, content),
      second = protector.protect(subject, content);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(reader.decrypt(subject, first)).toEqual(content);
    expect(resolve).toHaveBeenCalledWith('chat-key', 2);
    const closed = { ...content, status: 'closed' as const, closedAt: '2026-09-30T00:00:00.000Z' };
    expect(reader.decrypt(subject, protector.protect(subject, closed))).toEqual(closed);
    expect(key).toEqual(Buffer.alloc(32, 71));
    expect(Buffer.from(first.ciphertext).toString()).not.toContain(content.chatSessionId);
  });
  it('rejects message content, identities, malformed lifecycle times and unexpected fields', () => {
    for (const invalid of [
      { ...content, content: 'private message' },
      { ...content, participantId: randomUUID() },
      { ...content, closedAt: '2026-09-30T00:00:00.000Z' },
      { ...content, status: 'closed' },
      { ...content, status: 'closed', closedAt: '2026-02-30T00:00:00.000Z' },
      { ...content, status: 'closed', closedAt: '2026-09-30T00:00:00.000+03:30' },
      { ...content, chatSessionId: 'invalid' },
    ])
      expect(isReportChatContent(invalid)).toBe(false);
  });
  it('authenticates report, evidence, type, key version and ciphertext and rejects unsupported envelopes before key lookup', () => {
    const snapshot = new AesGcmChatReportSnapshotProtector('chat-key', 1, key).protect(
      subject,
      content,
    );
    const resolve = vi.fn(() => key),
      reader = new AesGcmChatReportSnapshotReader({ resolve });
    for (const change of [
      { snapshotType: 'profile' },
      { schemaVersion: 2 },
      { keyId: 'bad' },
      { nonce: Buffer.alloc(11) },
      { ciphertext: Buffer.alloc(65537) },
      { sha256: 'bad' },
    ])
      expect(() => reader.decrypt(subject, { ...snapshot, ...change })).toThrow(
        'Report snapshot could not be read.',
      );
    expect(resolve).not.toHaveBeenCalled();
    for (const changed of [
      { ...subject, reportId: randomUUID() },
      { ...subject, evidenceId: randomUUID() },
    ])
      expect(() => reader.decrypt(changed, snapshot)).toThrow();
    expect(() => reader.decrypt(subject, { ...snapshot, keyVersion: 2 })).toThrow();
    const ciphertext = Buffer.from(snapshot.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 1;
    expect(() => reader.decrypt(subject, { ...snapshot, ciphertext })).toThrow();
    expect(() =>
      new AesGcmProfileReportSnapshotReader({ resolve }).decrypt(subject, snapshot),
    ).toThrow();
  });
  it('rejects authenticated malformed content and hash mismatches without exposing provider diagnostics', () => {
    const reader = new AesGcmChatReportSnapshotReader({ resolve: () => key });
    for (const raw of [
      Buffer.from('private invalid json'),
      Buffer.from([255]),
      Buffer.from(JSON.stringify({ ...content, messageText: 'private text' })),
    ]) {
      const metadata = {
        schemaVersion: 1,
        snapshotType: 'chat',
        keyId: 'chat-key',
        keyVersion: 1,
        sha256: createHash('sha256').update(raw).digest('hex'),
      };
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(chatReportSnapshotAad(subject, metadata));
      const snapshot = {
        ...metadata,
        nonce,
        ciphertext: Buffer.concat([cipher.update(raw), cipher.final(), cipher.getAuthTag()]),
      };
      expect(() => reader.decrypt(subject, snapshot)).toThrow('Report snapshot could not be read.');
    }
    const snapshot = new AesGcmChatReportSnapshotProtector('chat-key', 1, key).protect(
      subject,
      content,
    );
    const failed = new AesGcmChatReportSnapshotReader({
      resolve: () => {
        throw new Error('private key detail');
      },
    });
    try {
      failed.decrypt(subject, snapshot);
      throw new Error('Expected decryption failure');
    } catch (error) {
      expect(error).toEqual(new Error('Report snapshot could not be read.'));
      expect(error).not.toHaveProperty('cause');
    }
    expect(() => reader.decrypt(subject, { ...snapshot, sha256: '0'.repeat(64) })).toThrow();
  });
});
