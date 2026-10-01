import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  isReportPhotoContent,
  photoReportSnapshotAad,
} from './photo-report-snapshot.js';
const key = Buffer.alloc(32, 75),
  subject = { reportId: randomUUID(), evidenceId: randomUUID() };
const content = {
  evidenceType: 'photo' as const,
  evidenceObjectRef: `v1.pe.${randomUUID()}`,
  contentSha256: 'a'.repeat(64),
  primary: true,
};
describe('encrypted minimal photo snapshots', () => {
  it('round trips a retained evidence reference with unique nonces and historical key identity', () => {
    const protector = new AesGcmPhotoReportSnapshotProtector('photo-key', 3, key);
    const resolve = vi.fn((id: string, version: number) =>
      id === 'photo-key' && version === 3 ? key : undefined,
    );
    const reader = new AesGcmPhotoReportSnapshotReader({ resolve });
    const first = protector.protect(subject, content),
      second = protector.protect(subject, content);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(reader.decrypt(subject, first)).toEqual(content);
    expect(resolve).toHaveBeenCalledWith('photo-key', 3);
    expect(Buffer.from(first.ciphertext).toString()).not.toContain(content.evidenceObjectRef);
    expect(key).toEqual(Buffer.alloc(32, 75));
  });
  it('rejects identity, raw storage keys, URLs, image bytes and malformed digests', () => {
    for (const invalid of [
      { ...content, userId: randomUUID() },
      { ...content, image: 'private bytes' },
      { ...content, evidenceObjectRef: 'variants/private/thumbnail.webp' },
      { ...content, evidenceObjectRef: 'https://private.invalid/photo' },
      { ...content, contentSha256: 'bad' },
      { ...content, primary: 'yes' },
    ])
      expect(isReportPhotoContent(invalid)).toBe(false);
  });
  it('rejects wrong bindings, type, keys, ciphertext and invalid envelopes before resolving keys', () => {
    const snapshot = new AesGcmPhotoReportSnapshotProtector('photo-key', 1, key).protect(
      subject,
      content,
    );
    const resolve = vi.fn(() => key),
      reader = new AesGcmPhotoReportSnapshotReader({ resolve });
    for (const change of [
      { snapshotType: 'profile' },
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
      new AesGcmPhotoReportSnapshotReader({
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
        snapshotType: 'photo' as const,
        keyId: 'photo-key',
        keyVersion: 1,
        sha256: createHash('sha256').update(plaintext).digest('hex'),
      };
      if (plaintext.equals(Buffer.from(JSON.stringify(content)))) envelope.sha256 = '0'.repeat(64);
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(photoReportSnapshotAad(subject, envelope));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      expect(() =>
        new AesGcmPhotoReportSnapshotReader({ resolve: () => key }).decrypt(subject, {
          ...envelope,
          nonce,
          ciphertext,
        }),
      ).toThrow('Report snapshot could not be read.');
    }
  });
});
