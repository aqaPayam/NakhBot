import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MediaTransportCipher } from '@nakh/application';

/** Versioned AES-GCM envelope, bound to the environment and owning asset.
 * Retain old key IDs until their outstanding ingestion intents have expired. */
export class TelegramMediaTransportCipher implements MediaTransportCipher {
  private readonly keys: ReadonlyMap<string, Buffer>;

  public constructor(
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    private readonly activeKeyId: string,
    keys: ReadonlyMap<string, Uint8Array>,
  ) {
    if (!keys.has(activeKeyId)) throw new Error('media_transport_key_missing');
    const copy = new Map<string, Buffer>();
    for (const [id, key] of keys) {
      if (!/^[A-Za-z0-9_-]{1,32}$/u.test(id) || key.byteLength !== 32)
        throw new Error('media_transport_key_invalid');
      copy.set(id, Buffer.from(key));
    }
    this.keys = copy;
  }

  public encrypt(telegramFileId: string, assetId: string): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(telegramFileId))
      return Promise.reject(new Error('media_transport_invalid'));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(this.context(assetId, this.activeKeyId));
    const encrypted = Buffer.concat([cipher.update(telegramFileId, 'utf8'), cipher.final()]);
    return Promise.resolve(
      Buffer.from(
        JSON.stringify({
          v: 1,
          kid: this.activeKeyId,
          iv: iv.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
          data: encrypted.toString('base64url'),
        }),
      ),
    );
  }

  public decrypt(
    ciphertext: Uint8Array,
    assetId: string,
  ): Promise<Readonly<{ telegramFileId: string }>> {
    try {
      if (ciphertext.byteLength === 0 || ciphertext.byteLength > 2048) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(ciphertext).toString('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
      const envelope = value as Record<string, unknown>;
      if (
        Object.keys(envelope).sort().join(',') !== 'data,iv,kid,tag,v' ||
        envelope.v !== 1 ||
        typeof envelope.kid !== 'string'
      )
        throw new Error();
      const key = this.keys.get(envelope.kid);
      if (key === undefined) throw new Error();
      const iv = this.decode(envelope.iv, 12, 12);
      const tag = this.decode(envelope.tag, 16, 16);
      const data = this.decode(envelope.data, 1, 512);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(this.context(assetId, envelope.kid));
      decipher.setAuthTag(tag);
      const telegramFileId = Buffer.concat([decipher.update(data), decipher.final()]).toString(
        'utf8',
      );
      if (!/^[A-Za-z0-9_-]{1,512}$/u.test(telegramFileId)) throw new Error();
      return Promise.resolve({ telegramFileId });
    } catch {
      return Promise.reject(new Error('media_transport_invalid'));
    }
  }

  private context(assetId: string, keyId: string): Buffer {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(assetId))
      throw new Error('media_transport_invalid');
    return Buffer.from(`nakh:telegram-media:v1:${this.environment}:${assetId}:${keyId}`);
  }

  private decode(value: unknown, minimum: number, maximum: number): Buffer {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64url') !== value)
      throw new Error();
    return bytes;
  }
}
