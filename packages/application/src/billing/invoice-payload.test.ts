import { describe, expect, it } from 'vitest';

import { AesGcmInvoicePayloadProtector } from './invoice-payload.js';

function deterministicRandom(): (size: number) => Uint8Array {
  let seed = 0;
  return (size) => Uint8Array.from({ length: size }, () => (seed++ * 31 + 17) % 256);
}

describe('M4 invoice payload protection', () => {
  it('issues an opaque 192-bit payload with a keyed digest and authenticated ciphertext', () => {
    const protector = new AesGcmInvoicePayloadProtector(
      'billing-v1',
      Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      deterministicRandom(),
    );
    const issued = protector.issue();
    expect(issued.cleartext).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(issued.cleartext).not.toContain('10000000-0000-4000-8000-000000000001');
    expect(issued.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.from(issued.ciphertext).toString('utf8')).not.toContain(issued.cleartext);
    expect(protector.reveal(issued.ciphertext, issued.keyId)).toBe(issued.cleartext);
    expect(protector.digest(issued.cleartext)).toBe(issued.digest);
  });

  it('rejects tampering, an unknown key version and malformed provider input', () => {
    const protector = new AesGcmInvoicePayloadProtector(
      'billing-v1',
      Uint8Array.from({ length: 32 }, () => 7),
      Uint8Array.from({ length: 32 }, () => 9),
      deterministicRandom(),
    );
    const issued = protector.issue();
    const tampered = Uint8Array.from(issued.ciphertext);
    const finalIndex = tampered.length - 1;
    tampered[finalIndex] = tampered[finalIndex]! ^ 1;
    expect(() => protector.reveal(tampered, issued.keyId)).toThrow(
      'Invoice payload cannot be recovered.',
    );
    expect(() => protector.reveal(issued.ciphertext, 'billing-v2')).toThrow(
      'Invoice payload cannot be recovered.',
    );
    expect(() => protector.digest('user:123;price:4')).toThrow('Invoice payload is invalid.');
  });

  it('does not let another encryption or digest key authenticate the payload', () => {
    const random = deterministicRandom();
    const first = new AesGcmInvoicePayloadProtector(
      'billing-v1',
      Uint8Array.from({ length: 32 }, () => 1),
      Uint8Array.from({ length: 32 }, () => 2),
      random,
    );
    const second = new AesGcmInvoicePayloadProtector(
      'billing-v1',
      Uint8Array.from({ length: 32 }, () => 3),
      Uint8Array.from({ length: 32 }, () => 4),
      random,
    );
    const issued = first.issue();
    expect(() => second.reveal(issued.ciphertext, issued.keyId)).toThrow(
      'Invoice payload cannot be recovered.',
    );
    expect(second.digest(issued.cleartext)).not.toBe(issued.digest);
  });
});
