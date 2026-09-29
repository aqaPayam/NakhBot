import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { normalizeReviewNote } from '@nakh/domain';

export type ProtectedReviewNote = Readonly<{
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyId: string;
  keyVersion: number;
  sha256: string;
}>;

export interface ReviewNoteProtector {
  protect(reviewId: string, note?: string): ProtectedReviewNote | undefined;
}

/** Encrypt before opening the decision transaction. This capability never reveals content. */
export class AesGcmReviewNoteProtector implements ReviewNoteProtector {
  private readonly key: Buffer;
  public constructor(
    private readonly keyId: string,
    private readonly keyVersion: number,
    key: Uint8Array,
  ) {
    if (
      !/^[A-Za-z0-9_-]{8,160}$/u.test(keyId) ||
      !Number.isSafeInteger(keyVersion) ||
      keyVersion < 1 ||
      key.byteLength !== 32
    )
      throw new Error('Review note encryption configuration is invalid.');
    this.key = Buffer.from(key);
  }

  public protect(reviewId: string, note?: string): ProtectedReviewNote | undefined {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(reviewId)
    )
      throw new Error('Review note target is invalid.');
    const normalized = normalizeReviewNote(note);
    if (normalized === undefined) return undefined;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify(['moderation-review-note', 1, reviewId, this.keyId, this.keyVersion]),
      ),
    );
    const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    return {
      ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
      nonce,
      keyId: this.keyId,
      keyVersion: this.keyVersion,
      sha256: createHash('sha256').update(normalized, 'utf8').digest('hex'),
    };
  }
}
