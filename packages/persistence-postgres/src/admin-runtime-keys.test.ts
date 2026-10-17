import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdminRuntimeKeys } from './admin-runtime-keys.js';

const encoded = (byte: number): string => Buffer.alloc(32, byte).toString('base64url');
const ring = (keyId: string, byte: number, keyVersion = 1): string =>
  JSON.stringify([{ keyId, keyVersion, key: encoded(byte) }]);
function input(): ConstructorParameters<typeof AdminRuntimeKeys>[0] {
  return {
    totp: ring('totp-test-key', 1),
    notes: ring('notes-test-key', 2),
    snapshots: ring('snapshot-test-key', 3),
    action: encoded(4),
    navigation: encoded(5),
    noteKeyId: 'notes-test-key',
    noteKeyVersion: 1,
    snapshotKeyId: 'snapshot-test-key',
    snapshotKeyVersion: 1,
  };
}
describe('actual administrator host key custody', () => {
  it('keeps opaque UI keys stable across restart and separate from first-factor and confirmation material', () => {
    const first = new AdminRuntimeKeys(input()),
      second = new AdminRuntimeKeys(input());
    expect(first.uiEncryptionKey).toEqual(second.uiEncryptionKey);
    expect(first.uiReferenceKey).toEqual(second.uiReferenceKey);
    expect(first.uiEncryptionKey).not.toEqual(first.uiReferenceKey);
    expect(first.uiEncryptionKey).not.toEqual(first.actionKey);
    expect(first.actionKey).not.toEqual(first.userSessionKey);
    expect(first.reviewNotes.protect(randomUUID(), 'Synthetic review note')).toMatchObject({
      keyId: 'notes-test-key',
      keyVersion: 1,
    });
  });
  it.each(['totp', 'notes', 'snapshots'] as const)(
    'rejects historical %s reuse of navigation or confirmation secrets',
    (purpose) => {
      for (const byte of [4, 5]) {
        const original = input();
        const old = { keyId: 'historical-alias', keyVersion: 7, key: encoded(byte) };
        const entries: unknown[] = JSON.parse(original[purpose]) as unknown[];
        expect(
          () => new AdminRuntimeKeys({ ...original, [purpose]: JSON.stringify([...entries, old]) }),
        ).toThrow('Administrator key custody unavailable.');
      }
    },
  );
  it('rejects cross-purpose aliases even when the active note key itself is separate', () => {
    const original = input();
    const entries = [
      { keyId: 'old-note-key', keyVersion: 1, key: encoded(1) },
      { keyId: 'notes-test-key', keyVersion: 2, key: encoded(2) },
    ];
    expect(
      () =>
        new AdminRuntimeKeys({ ...original, notes: JSON.stringify(entries), noteKeyVersion: 2 }),
    ).toThrow('Administrator key custody unavailable.');
    expect(
      () => new AdminRuntimeKeys({ ...original, snapshots: ring('snapshot-test-key', 2) }),
    ).toThrow('Administrator key custody unavailable.');
  });
  it('selects explicit write versions rather than array order and fails missing custody without echoing secrets', () => {
    const original = input();
    const notes = JSON.stringify([
      { keyId: 'notes-test-key', keyVersion: 2, key: encoded(6) },
      { keyId: 'notes-test-key', keyVersion: 1, key: encoded(2) },
    ]);
    expect(
      new AdminRuntimeKeys({ ...original, notes }).reviewNotes.protect(
        randomUUID(),
        'Synthetic note',
      ),
    ).toMatchObject({ keyVersion: 1 });
    for (const changed of [
      { noteKeyVersion: 3 },
      { snapshotKeyVersion: 3 },
      { action: 'private-invalid-secret' },
      { totp: 'private-invalid-json' },
      { action: original.navigation },
    ])
      expect(() => new AdminRuntimeKeys({ ...original, ...changed })).toThrow(
        'Administrator key custody unavailable.',
      );
  });
});
