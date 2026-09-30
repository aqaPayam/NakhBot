import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  isReportProfileContent,
  profileReportSnapshotAad,
  type ProtectedProfileReportSnapshot,
  type ReportSnapshotSubject,
} from './profile-report-snapshot.js';

const key = Buffer.alloc(32, 23);
function decrypt(subject: ReportSnapshotSubject, envelope: ProtectedProfileReportSnapshot): string {
  const ciphertext = Buffer.from(envelope.ciphertext);
  const cipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
  cipher.setAAD(profileReportSnapshotAad(subject, envelope));
  cipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]).toString(
    'utf8',
  );
}
describe('encrypted profile report snapshots', () => {
  it('captures only typed content with fresh nonces and authenticates every subject and envelope field', () => {
    const protector = new AesGcmProfileReportSnapshotProtector('report-key', 1, key);
    const subject = { reportId: randomUUID(), evidenceId: randomUUID() };
    const content = {
      evidenceType: 'profile' as const,
      displayName: 'Private name',
      birthYear: 2000,
      bio: 'private bio',
    };
    const first = protector.protect(subject, content),
      second = protector.protect(subject, content);
    expect(JSON.parse(decrypt(subject, first))).toEqual(content);
    expect(first.sha256).toBe(createHash('sha256').update(decrypt(subject, first)).digest('hex'));
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(Buffer.from(first.ciphertext).includes(Buffer.from(content.bio))).toBe(false);
    expect(() => decrypt({ ...subject, reportId: randomUUID() }, first)).toThrow();
    expect(() => decrypt({ ...subject, evidenceId: randomUUID() }, first)).toThrow();
    for (const change of [
      { keyId: 'different-key' },
      { keyVersion: 2 },
      { sha256: '0'.repeat(64) },
      { nonce: Buffer.alloc(12) },
    ])
      expect(() => decrypt(subject, { ...first, ...change })).toThrow();
    const altered = Buffer.from(first.ciphertext);
    altered[0] = altered[0]! ^ 1;
    expect(() => decrypt(subject, { ...first, ciphertext: altered })).toThrow();
  });
  it('rejects identities, extra fields, invalid Unicode and oversized content before encryption', () => {
    const protector = new AesGcmProfileReportSnapshotProtector('report-key', 1, key);
    const subject = { reportId: randomUUID(), evidenceId: randomUUID() };
    const content = {
      evidenceType: 'profile' as const,
      displayName: '😀'.repeat(80),
      birthYear: 1900,
      bio: '🌳'.repeat(1000),
    };
    expect(JSON.parse(decrypt(subject, protector.protect(subject, content)))).toEqual(content);
    for (const value of [
      { ...content, userId: randomUUID() },
      { ...content, birthYear: 1 },
      { ...content, displayName: '\ud800' },
      { ...content, bio: content.bio + 'a' },
      { ...content, displayName: '' },
      { ...content, evidenceType: 'photo' },
    ])
      expect(isReportProfileContent(value)).toBe(false);
    expect(() => protector.protect(subject, { ...content, bio: content.bio + 'a' })).toThrow(
      'content is invalid',
    );
    expect(() => protector.protect({ ...subject, reportId: 'bad' }, content)).toThrow(
      'binding is invalid',
    );
    expect(() => new AesGcmProfileReportSnapshotProtector('short', 1, key)).toThrow();
    expect(() => new AesGcmProfileReportSnapshotProtector('report-key', 0, key)).toThrow();
    expect(
      () => new AesGcmProfileReportSnapshotProtector('report-key', 1, Buffer.alloc(31)),
    ).toThrow();
  });
});
