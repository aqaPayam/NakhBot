import { describe, expect, it } from 'vitest';
import { TelegramStarsKeys } from './stars-keys.js';

const secret = (value: number): string => Buffer.alloc(32, value).toString('base64url');
const old = { id: 'v1', invoiceKey: secret(1), evidenceKey: secret(2) };
const next = { id: 'v2', invoiceKey: secret(3), evidenceKey: secret(4) };
const ring = (activeKeyId = 'v1', keys = [old], digestKey = secret(5)): string =>
  JSON.stringify({ activeKeyId, keys, digestKey });
describe('Stars financial key custody', () => {
  it('retains original invoices and evidence across active-key rotation', () => {
    const initial = new TelegramStarsKeys(ring()),
      rotated = new TelegramStarsKeys(ring('v2', [old, next]));
    const invoice = initial.issue(),
      evidence = initial.protectEvidence({ payer: '123', charge: 'opaque-charge' });
    expect(invoice.cleartext).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(rotated.reveal(invoice.ciphertext, invoice.keyId)).toBe(invoice.cleartext);
    expect(rotated.digest(invoice.cleartext)).toBe(invoice.digest);
    expect(rotated.openEvidence(evidence.ciphertext, evidence.keyId)).toEqual({
      payer: '123',
      charge: 'opaque-charge',
    });
    expect(rotated.issue().keyId).toBe('v2');
    expect(Buffer.from(evidence.ciphertext).toString('utf8')).not.toContain('opaque-charge');
  });
  it('binds evidence integrity and stable digest independently of object order and encryption nonce', () => {
    const keys = new TelegramStarsKeys(ring()),
      first = keys.protectEvidence({ a: 'one', b: 'two' }),
      second = keys.protectEvidence({ b: 'two', a: 'one' });
    expect(first.digest).toBe(second.digest);
    expect(keys.verifyEvidence(first.ciphertext, first.keyId, first.digest)).toEqual({
      a: 'one',
      b: 'two',
    });
    expect(() => keys.verifyEvidence(first.ciphertext, first.keyId, '0'.repeat(64))).toThrow(
      'Stars keys unavailable.',
    );
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    const corrupt = Buffer.from(first.ciphertext);
    corrupt[corrupt.length - 1]! ^= 1;
    expect(() => keys.openEvidence(corrupt, first.keyId)).toThrow('Stars keys unavailable.');
    expect(() => keys.openEvidence(first.ciphertext, 'missing')).toThrow('Stars keys unavailable.');
  });
  it('rejects missing, duplicate, reused or noncanonical secrets with a fixed error', () => {
    for (const encoded of [
      'private-secret',
      ring('missing'),
      ring('v1', [old, old]),
      ring('v1', [{ ...old, evidenceKey: old.invoiceKey }]),
      ring('v1', [old], old.invoiceKey),
      ring('v1', [{ ...old, invoiceKey: secret(1) + '=' }]),
      JSON.stringify({ ...JSON.parse(ring()), extra: 'private-secret' }),
    ]) {
      expect(() => new TelegramStarsKeys(encoded)).toThrow('Stars keys unavailable.');
    }
  });
  it('rejects navigation key reuse and evidence larger than its bounded schema', () => {
    const keys = new TelegramStarsKeys(ring());
    for (const value of [1, 2, 5])
      expect(() => keys.assertSeparateNavigationKey(Buffer.alloc(32, value))).toThrow(
        'Stars keys unavailable.',
      );
    expect(() => keys.assertSeparateNavigationKey(Buffer.alloc(32, 6))).not.toThrow();
    expect(() => keys.protectEvidence({ value: 'x'.repeat(8192) })).toThrow(
      'Stars keys unavailable.',
    );
  });
});
