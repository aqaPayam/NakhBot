import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  profileReportSnapshotAad,
} from './profile-report-snapshot.js';
import {
  AesGcmProfileReportSnapshotReader,
  type StoredProfileReportSnapshot,
} from './profile-report-snapshot-reader.js';

const key = Buffer.alloc(32, 33);
const content = {
  evidenceType: 'profile' as const,
  displayName: 'Restricted name',
  birthYear: 1995,
  bio: 'Restricted bio',
};
const subject = { reportId: randomUUID(), evidenceId: randomUUID() };
describe('internal profile snapshot reader', () => {
  it('resolves the exact historical key version, preserves provider key bytes and authenticates the subject', () => {
    const resolve = vi.fn((keyId: string, version: number) =>
      keyId === 'report-key' && version === 2 ? key : undefined,
    );
    const reader = new AesGcmProfileReportSnapshotReader({ resolve });
    const snapshot = new AesGcmProfileReportSnapshotProtector('report-key', 2, key).protect(
      subject,
      content,
    );
    expect(reader.decrypt(subject, snapshot)).toEqual(content);
    expect(resolve).toHaveBeenCalledWith('report-key', 2);
    expect(key).toEqual(Buffer.alloc(32, 33));
    expect(() => reader.decrypt({ ...subject, reportId: randomUUID() }, snapshot)).toThrow(
      'Report snapshot could not be read.',
    );
    expect(() => reader.decrypt({ ...subject, evidenceId: randomUUID() }, snapshot)).toThrow(
      'Report snapshot could not be read.',
    );
    expect(() => reader.decrypt(subject, { ...snapshot, keyVersion: 1 })).toThrow(
      'Report snapshot could not be read.',
    );
  });
  it('rejects unsupported, oversized and malformed envelopes before requesting a key', () => {
    const resolve = vi.fn(() => key);
    const reader = new AesGcmProfileReportSnapshotReader({ resolve });
    const snapshot = new AesGcmProfileReportSnapshotProtector('report-key', 1, key).protect(
      subject,
      content,
    );
    for (const change of [
      { schemaVersion: 2 },
      { snapshotType: 'message' },
      { keyId: 'bad' },
      { sha256: 'bad' },
      { nonce: Buffer.alloc(11) },
      { ciphertext: Buffer.alloc(16) },
      { ciphertext: Buffer.alloc(65537) },
    ])
      expect(() => reader.decrypt(subject, { ...snapshot, ...change })).toThrow(
        'Report snapshot could not be read.',
      );
    expect(resolve).not.toHaveBeenCalled();
  });
  it('rejects authenticated invalid content, hash mismatch and corrupt bytes without revealing details', () => {
    const reader = new AesGcmProfileReportSnapshotReader({ resolve: () => key });
    function seal(
      raw: Buffer,
      sha256 = createHash('sha256').update(raw).digest('hex'),
    ): StoredProfileReportSnapshot {
      const metadata = {
        schemaVersion: 1 as const,
        snapshotType: 'profile' as const,
        keyId: 'report-key',
        keyVersion: 1,
        sha256,
      };
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(profileReportSnapshotAad(subject, metadata));
      return {
        ...metadata,
        nonce,
        ciphertext: Buffer.concat([cipher.update(raw), cipher.final(), cipher.getAuthTag()]),
      };
    }
    for (const snapshot of [
      seal(Buffer.from('private invalid json')),
      seal(Buffer.from([255])),
      seal(Buffer.from(JSON.stringify({ ...content, userId: randomUUID() }))),
      seal(Buffer.from(JSON.stringify(content)), '0'.repeat(64)),
    ])
      expect(() => reader.decrypt(subject, snapshot)).toThrow('Report snapshot could not be read.');
    const snapshot = seal(Buffer.from(JSON.stringify(content)));
    const damaged = Buffer.from(snapshot.ciphertext);
    damaged[0] = damaged[0]! ^ 1;
    expect(() => reader.decrypt(subject, { ...snapshot, ciphertext: damaged })).toThrow(
      'Report snapshot could not be read.',
    );
    const failed = new AesGcmProfileReportSnapshotReader({
      resolve: () => {
        throw new Error('private provider diagnostic');
      },
    });
    expect(() => failed.decrypt(subject, snapshot)).toThrow('Report snapshot could not be read.');
    try {
      failed.decrypt(subject, snapshot);
    } catch (error) {
      expect(error).not.toHaveProperty('cause');
    }
  });
});
