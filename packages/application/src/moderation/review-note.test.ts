import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmReviewNoteProtector, type ProtectedReviewNote } from './review-note.js';

const key = Buffer.alloc(32, 17);
function reveal(reviewId: string, value: ProtectedReviewNote, decryptionKey = key): string {
  const ciphertext = Buffer.from(value.ciphertext);
  const cipher = createDecipheriv('aes-256-gcm', decryptionKey, value.nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify(['moderation-review-note', 1, reviewId, value.keyId, value.keyVersion]),
    ),
  );
  cipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]).toString(
    'utf8',
  );
}
describe('restricted review note encryption', () => {
  it('normalizes text, encrypts with fresh nonces, and binds the exact review and key version', () => {
    const protector = new AesGcmReviewNoteProtector('review-key', 1, key);
    const id = randomUUID();
    const first = protector.protect(id, '  cafe\u0301 private note  ')!;
    const second = protector.protect(id, 'café private note')!;
    expect(reveal(id, first)).toBe('café private note');
    expect(first.sha256).toBe(createHash('sha256').update('café private note').digest('hex'));
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(Buffer.from(first.ciphertext).includes(Buffer.from('private note'))).toBe(false);
    expect(() => reveal(randomUUID(), first)).toThrow();
    expect(() => reveal(id, { ...first, keyVersion: 2 })).toThrow();
    expect(() => reveal(id, { ...first, keyId: 'another-key' })).toThrow();
    expect(() => reveal(id, first, Buffer.alloc(32, 18))).toThrow();
    const altered = Buffer.from(first.ciphertext);
    altered[0] = altered[0]! ^ 1;
    expect(() => reveal(id, { ...first, ciphertext: altered })).toThrow();
  });
  it('handles absence and maximum Unicode scalar length without persisting empty envelopes', () => {
    const protector = new AesGcmReviewNoteProtector('review-key', 1, key);
    const id = randomUUID();
    expect(protector.protect(id)).toBeUndefined();
    expect(protector.protect(id, '  ')).toBeUndefined();
    const note = '😀'.repeat(2000);
    const envelope = protector.protect(id, note)!;
    expect(envelope.ciphertext.byteLength).toBe(8016);
    expect(reveal(id, envelope)).toBe(note);
    expect(() => protector.protect(id, `${note}x`)).toThrow();
  });
  it('rejects invalid configuration and copies the supplied key', () => {
    expect(() => new AesGcmReviewNoteProtector('short', 1, key)).toThrow();
    expect(() => new AesGcmReviewNoteProtector('review-key', 0, key)).toThrow();
    expect(() => new AesGcmReviewNoteProtector('review-key', 1, Buffer.alloc(31))).toThrow();
    const supplied = Buffer.from(key);
    const protector = new AesGcmReviewNoteProtector('review-key', 1, supplied);
    supplied.fill(0);
    const id = randomUUID();
    expect(reveal(id, protector.protect(id, 'private')!)).toBe('private');
    expect(() => protector.protect('invalid', 'private')).toThrow();
  });
});
