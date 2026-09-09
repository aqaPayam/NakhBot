import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BeginTelegramPhotoIngestionCommand } from '@nakh/contracts';
import { BeginTelegramPhotoIngestionHandler, type BeginMediaIngestionWrite } from './ingestion.js';

function command(): BeginTelegramPhotoIngestionCommand {
  return {
    commandId: randomUUID(),
    commandType: 'media.begin-telegram-photo-ingestion',
    schemaVersion: 1,
    actor: { kind: 'user', userId: randomUUID() },
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { telegramFileId: 'file', telegramFileUniqueId: 'unique', declaredSizeBytes: 10485761 },
  };
}

describe('BeginTelegramPhotoIngestionHandler', () => {
  it('encrypts against the generated asset and preserves coarse rejections for attempt accounting', async () => {
    const input = command();
    let encryptedAsset: string | undefined;
    let persisted: BeginMediaIngestionWrite | undefined;
    const handler = new BeginTelegramPhotoIngestionHandler(
      {
        beginTelegramIngestion: (write) => {
          persisted = write;
          return Promise.resolve({
            assetId: write.assetId,
            validationState: 'rejected',
            errorCode: 'media_too_large',
            acceptedAt: input.occurredAt,
            replayed: false,
          });
        },
      },
      {
        encrypt: (file, asset) => {
          expect(file).toBe('file');
          encryptedAsset = asset;
          return Promise.resolve(new Uint8Array([1, 2]));
        },
      },
      { uuid: randomUUID },
      { consume: () => Promise.resolve({ allowed: true, remaining: 29, retryAfterSeconds: 0 }) },
    );
    await expect(handler.execute(input)).resolves.toMatchObject({ errorCode: 'media_too_large' });
    expect(persisted?.assetId).toBe(encryptedAsset);
    expect(persisted?.transportMetadataCiphertext).toEqual(new Uint8Array([1, 2]));
  });

  it('rejects system actors and rate-limited requests before encryption or persistence', async () => {
    const forbidden = (): Promise<never> => Promise.reject(new Error('must not execute'));
    const handler = new BeginTelegramPhotoIngestionHandler(
      { beginTelegramIngestion: forbidden },
      { encrypt: forbidden },
      { uuid: randomUUID },
      { consume: () => Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 60 }) },
    );
    const input = command();
    await expect(
      handler.execute({ ...input, actor: { ...input.actor, kind: 'system' } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(handler.execute(input)).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
