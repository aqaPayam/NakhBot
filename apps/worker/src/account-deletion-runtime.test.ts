import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmProfileReportSnapshotProtector } from '@nakh/application';
import { loadDeletionEvidenceReaders } from './account-deletion-runtime.js';

describe('deletion worker preloaded evidence capabilities', () => {
  it('authenticates historical and active key versions and denies cross-subject substitution', () => {
    const old = Buffer.alloc(32, 3),
      active = Buffer.alloc(32, 4);
    const readers = loadDeletionEvidenceReaders(
      JSON.stringify([
        { keyId: 'report-key', keyVersion: 1, key: old.toString('base64url') },
        { keyId: 'report-key', keyVersion: 2, key: active.toString('base64url') },
      ]),
    );
    const subject = { reportId: randomUUID(), evidenceId: randomUUID() };
    const content = {
      evidenceType: 'profile' as const,
      displayName: 'PRIVATE PROFILE',
      birthYear: 1990,
    };
    for (const [version, key] of [
      [1, old],
      [2, active],
    ] as const) {
      const snapshot = new AesGcmProfileReportSnapshotProtector('report-key', version, key).protect(
        subject,
        content,
      );
      expect(readers.profile!.decrypt(subject, snapshot)).toEqual(content);
      expect(() =>
        readers.profile!.decrypt({ ...subject, evidenceId: randomUUID() }, snapshot),
      ).toThrow();
      expect(() => readers.profile!.decrypt(subject, { ...snapshot, keyVersion: 3 })).toThrow();
    }
    expect(Object.keys(readers).sort()).toEqual([
      'chat',
      'message',
      'photo',
      'profile',
      'unmatched_user',
    ]);
    expect(Object.isFrozen(readers)).toBe(true);
  });
  it.each([
    'PRIVATE MALFORMED JSON',
    '[]',
    '{}',
    JSON.stringify([{ keyId: 'report-key', keyVersion: 1, key: 'PRIVATE BAD KEY' }]),
    JSON.stringify(
      Array.from({ length: 2 }, () => ({
        keyId: 'report-key',
        keyVersion: 1,
        key: Buffer.alloc(32).toString('base64url'),
      })),
    ),
    JSON.stringify([
      {
        keyId: 'report-key',
        keyVersion: 1,
        key: Buffer.alloc(32).toString('base64url'),
        extra: 'PRIVATE',
      },
    ]),
  ])('rejects unusable or ambiguous configuration without echoing secrets (%#)', (encoded) => {
    expect(() => loadDeletionEvidenceReaders(encoded)).toThrowError(
      new Error('Deletion evidence key configuration unavailable.'),
    );
  });
});
