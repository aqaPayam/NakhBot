import { createHmac, randomBytes } from 'node:crypto';

import {
  invalidAudienceCredential,
  mediaAudiencePayload,
  validateAudienceKeyId,
  validateAudienceOrigin,
} from './audience-claims.js';

export type MediaAudienceKeyRing = Readonly<{
  currentKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

/** Trusted delivery-service issuer. Its independent key never reaches clients or Telegram. */
export class HmacMediaAudienceCredentials {
  private readonly keys: ReadonlyMap<string, Uint8Array>;
  private readonly keyId: string;
  private readonly origin: string;

  public constructor(
    mediaOrigin: string,
    ring: MediaAudienceKeyRing,
    private readonly ttlSeconds = 60,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 10 ||
      ttlSeconds > 120 ||
      ring.keys.size < 1 ||
      ring.keys.size > 3 ||
      !ring.keys.has(ring.currentKeyId)
    )
      invalidAudienceCredential();
    this.origin = validateAudienceOrigin(mediaOrigin);
    validateAudienceKeyId(ring.currentKeyId);
    for (const [keyId, key] of ring.keys) {
      validateAudienceKeyId(keyId);
      if (key.byteLength < 32 || key.byteLength > 64) invalidAudienceCredential();
    }
    this.keys = new Map([...ring.keys].map(([keyId, key]) => [keyId, Uint8Array.from(key)]));
    this.keyId = ring.currentKeyId;
  }

  public tokenFor(viewerUserId: string): Promise<string> {
    const issuedAt = this.now();
    const payload = mediaAudiencePayload(this.keyId, {
      origin: this.origin,
      audienceId: viewerUserId,
      issuedAt,
      expiresAt: issuedAt + this.ttlSeconds,
      nonce: randomBytes(12).toString('base64url'),
    });
    const encoded = Buffer.from(payload).toString('base64url');
    const signature = createHmac('sha256', this.keys.get(this.keyId)!)
      .update(encoded)
      .digest('base64url');
    return Promise.resolve(`${encoded}.${signature}`);
  }
}
