import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type { InvoicePayloadProtector, ProtectedInvoicePayload } from './funding.js';

const version = 1;
const nonceLength = 12;
const tagLength = 16;
const payloadPattern = /^[A-Za-z0-9_-]{32}$/u;

type RandomSource = (size: number) => Uint8Array;

function copyKey(value: Uint8Array, name: string): Buffer {
  if (value.byteLength !== 32) throw new Error(`${name} must contain exactly 32 bytes.`);
  return Buffer.from(value);
}

/** Opaque Telegram invoice payloads. Neither cleartext nor ciphertext is safe for logs. */
export class AesGcmInvoicePayloadProtector implements InvoicePayloadProtector {
  private readonly encryptionKey: Buffer;
  private readonly digestKey: Buffer;

  public constructor(
    private readonly keyId: string,
    encryptionKey: Uint8Array,
    digestKey: Uint8Array,
    private readonly random: RandomSource = randomBytes,
  ) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(keyId))
      throw new Error('Invoice payload key identifier is invalid.');
    this.encryptionKey = copyKey(encryptionKey, 'Invoice encryption key');
    this.digestKey = copyKey(digestKey, 'Invoice digest key');
  }

  public issue(): ProtectedInvoicePayload {
    const cleartext = Buffer.from(this.random(24)).toString('base64url');
    if (!payloadPattern.test(cleartext))
      throw new Error('Invoice payload entropy source is invalid.');
    const nonce = Buffer.from(this.random(nonceLength));
    if (nonce.byteLength !== nonceLength) throw new Error('Invoice nonce source is invalid.');
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce, {
      authTagLength: tagLength,
    });
    const encrypted = Buffer.concat([cipher.update(cleartext, 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([
      Buffer.from([version]),
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]);
    return {
      cleartext,
      digest: this.digest(cleartext),
      ciphertext: Uint8Array.from(ciphertext),
      keyId: this.keyId,
    };
  }

  public digest(cleartext: string): string {
    if (!payloadPattern.test(cleartext)) throw new Error('Invoice payload is invalid.');
    return createHmac('sha256', this.digestKey).update(cleartext, 'utf8').digest('hex');
  }

  public reveal(ciphertext: Uint8Array, keyId: string): string {
    if (keyId !== this.keyId || ciphertext.byteLength <= 1 + nonceLength + tagLength)
      throw new Error('Invoice payload cannot be recovered.');
    const value = Buffer.from(ciphertext);
    const suppliedVersion = value[0];
    if (
      suppliedVersion === undefined ||
      !timingSafeEqual(Buffer.from([suppliedVersion]), Buffer.from([version]))
    )
      throw new Error('Invoice payload cannot be recovered.');
    const nonce = value.subarray(1, 1 + nonceLength);
    const tag = value.subarray(1 + nonceLength, 1 + nonceLength + tagLength);
    const encrypted = value.subarray(1 + nonceLength + tagLength);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce, {
        authTagLength: tagLength,
      });
      decipher.setAuthTag(tag);
      const cleartext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
        'utf8',
      );
      if (!payloadPattern.test(cleartext)) throw new Error('invalid plaintext');
      return cleartext;
    } catch {
      throw new Error('Invoice payload cannot be recovered.');
    }
  }
}
