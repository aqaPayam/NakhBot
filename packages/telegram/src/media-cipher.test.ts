import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelegramMediaTransportCipher } from './media-cipher.js';

describe('TelegramMediaTransportCipher', () => {
  it('uses random nonces and supports key rotation for outstanding intents', async () => {
    const keys = new Map([
      ['old', randomBytes(32)],
      ['new', randomBytes(32)],
    ]);
    const old = new TelegramMediaTransportCipher('test', 'old', keys);
    const rotated = new TelegramMediaTransportCipher('test', 'new', keys);
    const assetId = randomUUID();
    const first = await old.encrypt('telegram-file-id', assetId);
    const second = await old.encrypt('telegram-file-id', assetId);
    expect(first).not.toEqual(second);
    expect(Buffer.from(first).toString()).not.toContain('telegram-file-id');
    await expect(rotated.decrypt(first, assetId)).resolves.toEqual({
      telegramFileId: 'telegram-file-id',
    });
    await expect(rotated.decrypt(first, randomUUID())).rejects.toThrow('media_transport_invalid');
    await expect(
      new TelegramMediaTransportCipher('production', 'new', keys).decrypt(first, assetId),
    ).rejects.toThrow('media_transport_invalid');
  });

  it('rejects tampering, wrong keys, malformed and oversized envelopes with one safe error', async () => {
    const cipher = new TelegramMediaTransportCipher(
      'test',
      'key',
      new Map([['key', randomBytes(32)]]),
    );
    const assetId = randomUUID();
    const encrypted = await cipher.encrypt('file', assetId);
    const changed = Buffer.from(encrypted);
    changed[changed.length - 5] = 65;
    for (const bytes of [changed, Buffer.from('{}'), Buffer.alloc(2049)])
      await expect(cipher.decrypt(bytes, assetId)).rejects.toThrow('media_transport_invalid');
    const wrong = new TelegramMediaTransportCipher(
      'test',
      'key',
      new Map([['key', randomBytes(32)]]),
    );
    await expect(wrong.decrypt(encrypted, assetId)).rejects.toThrow('media_transport_invalid');
  });
});
