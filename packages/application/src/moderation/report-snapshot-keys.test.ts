import { describe, expect, it } from 'vitest';
import { ReportSnapshotKeyRing } from './report-snapshot-keys.js';

const row = { keyId: 'report-key', keyVersion: 1, key: Buffer.alloc(32, 3).toString('base64url') };
describe('shared retained report snapshot key ring', () => {
  it('rejects cross-purpose reuse of historical material even under different key names', () => {
    const first = new ReportSnapshotKeyRing(JSON.stringify([row]));
    const reused = new ReportSnapshotKeyRing(
      JSON.stringify([{ ...row, keyId: 'another-purpose', keyVersion: 7 }]),
    );
    expect(() => first.assertSeparateKeyRing(reused)).toThrow('configuration unavailable');
    const separate = new ReportSnapshotKeyRing(
      JSON.stringify([{ ...row, key: Buffer.alloc(32, 9).toString('base64url') }]),
    );
    expect(() => first.assertSeparateKeyRing(separate)).not.toThrow();
  });
  it('selects an explicit version while retaining historical readers and isolated key copies', () => {
    const ring = new ReportSnapshotKeyRing(
      JSON.stringify([
        row,
        { ...row, keyVersion: 2, key: Buffer.alloc(32, 4).toString('base64url') },
      ]),
    );
    const active = ring.writeKey('report-key', 2);
    expect(active.key).toEqual(Uint8Array.from(Buffer.alloc(32, 4)));
    expect(ring.resolve('report-key', 1)).toEqual(Uint8Array.from(Buffer.alloc(32, 3)));
    active.key.fill(0);
    expect(ring.resolve('report-key', 2)).toEqual(Uint8Array.from(Buffer.alloc(32, 4)));
    expect(() => ring.writeKey('report-key', 3)).toThrow('Report snapshot write key unavailable.');
    expect(() => ring.assertSeparateNavigationKey(Buffer.alloc(32, 3))).toThrow(
      'Report snapshot key configuration unavailable.',
    );
    expect(() => ring.assertSeparateNavigationKey(Buffer.alloc(32, 5))).not.toThrow();
  });
  it.each([
    'private-malformed-key-json',
    '[]',
    '{}',
    JSON.stringify([row, row]),
    JSON.stringify([{ ...row, key: 'invalid' }]),
    JSON.stringify([{ ...row, extra: 'private' }]),
  ])('rejects invalid or ambiguous secrets without echoing material (%#)', (encoded) => {
    expect(() => new ReportSnapshotKeyRing(encoded)).toThrow(
      'Report snapshot key configuration unavailable.',
    );
  });
});
