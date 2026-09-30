import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  isReportUnmatchedContent,
  unmatchedReportSnapshotAad,
} from './unmatched-report-snapshot.js';
const key = Buffer.alloc(32, 75),
  subject = { reportId: randomUUID(), evidenceId: randomUUID() };
const content = {
  evidenceType: 'unmatched_user' as const,
  unmatchedAt: '2026-09-29T12:00:00.123Z',
  reportWindowExpiresAt: '2026-09-30T12:00:00.123Z',
};
describe('encrypted minimal unmatch snapshots', () => {
  it('round trips an exact window with unique nonces and historical key identity', () => {
    const protector = new AesGcmUnmatchedReportSnapshotProtector('unmatch-key', 3, key);
    const resolve = vi.fn((id: string, version: number) =>
      id === 'unmatch-key' && version === 3 ? key : undefined,
    );
    const reader = new AesGcmUnmatchedReportSnapshotReader({ resolve });
    const first = protector.protect(subject, content),
      second = protector.protect(subject, content);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(reader.decrypt(subject, first)).toEqual(content);
    expect(resolve).toHaveBeenCalledWith('unmatch-key', 3);
    expect(Buffer.from(first.ciphertext).toString()).not.toContain(content.unmatchedAt);
    expect(key).toEqual(Buffer.alloc(32, 75));
  });
  it('rejects identity, reasons, invalid dates and windows other than exactly 24 hours', () => {
    for (const invalid of [
      { ...content, userId: randomUUID() },
      { ...content, reason: 'private' },
      { ...content, unmatchedAt: '2026-02-30T12:00:00.123Z' },
      { ...content, unmatchedAt: '2026-09-29T12:00:00.123+00:00' },
      { ...content, reportWindowExpiresAt: content.unmatchedAt },
      { ...content, reportWindowExpiresAt: '2026-09-30T12:00:00.124Z' },
    ])
      expect(isReportUnmatchedContent(invalid)).toBe(false);
  });
  it('rejects wrong bindings, type, keys, ciphertext and invalid envelopes before resolving keys', () => {
    const snapshot = new AesGcmUnmatchedReportSnapshotProtector('unmatch-key', 1, key).protect(
      subject,
      content,
    );
    const resolve = vi.fn(() => key),
      reader = new AesGcmUnmatchedReportSnapshotReader({ resolve });
    for (const change of [
      { snapshotType: 'chat' },
      { schemaVersion: 2 },
      { nonce: Buffer.alloc(0) },
      { ciphertext: Buffer.alloc(65537) },
      { sha256: 'bad' },
      { keyId: 'bad' },
    ])
      expect(() => reader.decrypt(subject, { ...snapshot, ...change })).toThrow(
        'Report snapshot could not be read.',
      );
    expect(resolve).not.toHaveBeenCalled();
    expect(() => reader.decrypt({ ...subject, reportId: randomUUID() }, snapshot)).toThrow();
    expect(() => reader.decrypt({ ...subject, evidenceId: randomUUID() }, snapshot)).toThrow();
    expect(() => reader.decrypt(subject, { ...snapshot, keyVersion: 2 })).toThrow();
    const corrupt = Buffer.from(snapshot.ciphertext);
    corrupt[0] = corrupt[0]! ^ 1;
    expect(() => reader.decrypt(subject, { ...snapshot, ciphertext: corrupt })).toThrow();
    expect(() =>
      new AesGcmUnmatchedReportSnapshotReader({
        resolve: () => {
          throw new Error('private provider data');
        },
      }).decrypt(subject, snapshot),
    ).toThrow('Report snapshot could not be read.');
  });
  it('rejects authenticated extra content, invalid UTF-8 and hash mismatch', () => {
    for (const plaintext of [
      Buffer.from([255]),
      Buffer.from('private non-json'),
      Buffer.from(JSON.stringify({ ...content, identity: 'private' })),
      Buffer.from(JSON.stringify(content)),
    ]) {
      const envelope = {
        schemaVersion: 1 as const,
        snapshotType: 'unmatched_user' as const,
        keyId: 'unmatch-key',
        keyVersion: 1,
        sha256: createHash('sha256').update(plaintext).digest('hex'),
      };
      if (plaintext.equals(Buffer.from(JSON.stringify(content)))) envelope.sha256 = '0'.repeat(64);
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(unmatchedReportSnapshotAad(subject, envelope));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      expect(() =>
        new AesGcmUnmatchedReportSnapshotReader({ resolve: () => key }).decrypt(subject, {
          ...envelope,
          nonce,
          ciphertext,
        }),
      ).toThrow('Report snapshot could not be read.');
    }
  });
});
