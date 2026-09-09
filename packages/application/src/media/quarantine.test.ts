import { describe, expect, it } from 'vitest';
import { MEDIA_LIMITS } from '@nakh/domain';
import { DownloadTelegramPhotoToQuarantine } from './quarantine.js';
import type { MalwareScannerPort } from './ingestion.js';

function source(...chunks: number[][]): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    for (const chunk of chunks) yield new Uint8Array(chunk);
  })();
}

function cleanScanner(result: 'clean' | 'detected' = 'clean'): MalwareScannerPort {
  return {
    start: () =>
      Promise.resolve({
        inspect: () => Promise.resolve(),
        complete: () =>
          Promise.resolve({
            result,
            scannerVersion: 'scanner-1',
            signatureVersion: 'signatures-1',
          }),
        abort: () => Promise.resolve(),
      }),
  };
}

describe('DownloadTelegramPhotoToQuarantine', () => {
  it('replays completed uploads without fetching or overwriting the object', async () => {
    const forbidden = (): Promise<never> =>
      Promise.reject(new Error('must not perform external work'));
    const result = await new DownloadTelegramPhotoToQuarantine(
      {
        claimPendingQuarantine: () =>
          Promise.resolve({
            assetId: 'asset',
            quarantineKey: 'key',
            completed: { bytes: 3, sha256: 'a'.repeat(64) },
          }),
        markQuarantineUploaded: forbidden,
        markDownloadRejected: forbidden,
        releaseQuarantineClaim: forbidden,
      },
      { download: forbidden },
      { put: forbidden, delete: forbidden },
      cleanScanner(),
    ).execute('asset', 'worker');
    expect(result).toEqual({ assetId: 'asset', bytes: 3, sha256: 'a'.repeat(64) });
  });
  it('streams an accepted file to the exact database key and records the digest result', async () => {
    const uploaded: { key: string; chunks: number[][] }[] = [];
    const marked: unknown[] = [];
    const result = await new DownloadTelegramPhotoToQuarantine(
      {
        claimPendingQuarantine: () =>
          Promise.resolve({
            assetId: 'asset-1',
            quarantineKey: 'quarantine/test/asset-1/original',
            telegramFileId: 'file-1',
          }),
        markQuarantineUploaded: (input) => {
          marked.push(input);
          return Promise.resolve();
        },
        markDownloadRejected: () => Promise.reject(new Error('must not reject')),
        releaseQuarantineClaim: () => Promise.resolve(),
      },
      { download: () => Promise.resolve({ body: source([1, 2], [3]), contentLength: 3 }) },
      {
        put: (input) =>
          (async () => {
            const chunks: number[][] = [];
            for await (const chunk of input.body) chunks.push([...chunk]);
            uploaded.push({ key: input.key, chunks });
            return { bytes: 3, sha256: 'a'.repeat(64) };
          })(),
        delete: () => Promise.reject(new Error('must not delete')),
      },
      cleanScanner(),
      () => new Date('2026-09-08T00:00:00.000Z'),
    ).execute('asset-1', 'worker');
    expect(result).toEqual({ assetId: 'asset-1', bytes: 3, sha256: 'a'.repeat(64) });
    expect(uploaded).toEqual([{ key: 'quarantine/test/asset-1/original', chunks: [[1, 2], [3]] }]);
    expect(marked).toEqual([
      {
        assetId: 'asset-1',
        bytes: 3,
        sha256: 'a'.repeat(64),
        uploadedAt: new Date('2026-09-08T00:00:00.000Z'),
        owner: 'worker',
        scannerVersion: 'scanner-1',
        signatureVersion: 'signatures-1',
        scannedAt: new Date('2026-09-08T00:00:00.000Z'),
      },
    ]);
  });

  it('rejects a known oversized response before writing an object', async () => {
    let puts = 0;
    const rejected: unknown[] = [];
    const result = await new DownloadTelegramPhotoToQuarantine(
      {
        claimPendingQuarantine: () =>
          Promise.resolve({
            assetId: 'asset-2',
            quarantineKey: 'quarantine/test/asset-2/original',
            telegramFileId: 'file-2',
          }),
        markQuarantineUploaded: () => Promise.reject(new Error('must not upload')),
        markDownloadRejected: (input) => {
          rejected.push(input);
          return Promise.resolve();
        },
        releaseQuarantineClaim: () => Promise.resolve(),
      },
      {
        download: () =>
          Promise.resolve({
            body: source([1]),
            contentLength: MEDIA_LIMITS.maximumUploadBytes + 1,
          }),
      },
      {
        put: () => {
          puts += 1;
          return Promise.resolve({ bytes: 1, sha256: 'a'.repeat(64) });
        },
        delete: () => Promise.resolve(),
      },
      cleanScanner(),
      () => new Date('2026-09-08T00:00:00.000Z'),
    ).execute('asset-2', 'worker');
    expect(result).toEqual({ assetId: 'asset-2', bytes: 0, sha256: '' });
    expect(puts).toBe(0);
    expect(rejected).toEqual([
      {
        assetId: 'asset-2',
        errorCode: 'media_too_large',
        failedAt: new Date('2026-09-08T00:00:00.000Z'),
        owner: 'worker',
      },
    ]);
  });

  it('deletes a partial object and records a bounded-stream overflow', async () => {
    const deleted: string[] = [];
    const rejected: unknown[] = [];
    const result = await new DownloadTelegramPhotoToQuarantine(
      {
        claimPendingQuarantine: () =>
          Promise.resolve({
            assetId: 'asset-3',
            quarantineKey: 'quarantine/test/asset-3/original',
            telegramFileId: 'file-3',
          }),
        markQuarantineUploaded: () => Promise.reject(new Error('must not complete')),
        markDownloadRejected: (input) => {
          rejected.push(input);
          return Promise.resolve();
        },
        releaseQuarantineClaim: () => Promise.resolve(),
      },
      {
        download: () =>
          Promise.resolve({
            body: source([1, 2], new Array<number>(MEDIA_LIMITS.maximumUploadBytes).fill(1)),
          }),
      },
      {
        put: (input) =>
          (async () => {
            for await (const chunk of input.body) void chunk;
            return { bytes: 0, sha256: '' };
          })(),
        delete: (key) => {
          deleted.push(key);
          return Promise.resolve();
        },
      },
      cleanScanner(),
      () => new Date('2026-09-08T00:00:00.000Z'),
    ).execute('asset-3', 'worker');
    expect(result.bytes).toBe(0);
    expect(deleted).toEqual(['quarantine/test/asset-3/original']);
    expect(rejected).toMatchObject([{ assetId: 'asset-3', errorCode: 'media_too_large' }]);
  });

  it('deletes a detected object and records a safe malware rejection', async () => {
    const rejected: unknown[] = [];
    let deleted = false;
    const handler = new DownloadTelegramPhotoToQuarantine(
      {
        claimPendingQuarantine: () =>
          Promise.resolve({ assetId: 'asset-4', quarantineKey: 'key', telegramFileId: 'file' }),
        markQuarantineUploaded: () => Promise.reject(new Error('must not upload')),
        markDownloadRejected: (input) => {
          rejected.push(input);
          return Promise.resolve();
        },
        releaseQuarantineClaim: () => Promise.resolve(),
      },
      { download: () => Promise.resolve({ body: source([1]) }) },
      {
        put: async ({ body }) => {
          for await (const chunk of body) void chunk;
          return { bytes: 1, sha256: 'a'.repeat(64) };
        },
        delete: () => {
          deleted = true;
          return Promise.resolve();
        },
      },
      cleanScanner('detected'),
    );
    await expect(handler.execute('asset-4', 'worker')).resolves.toMatchObject({ bytes: 0 });
    expect(deleted).toBe(true);
    expect(rejected).toMatchObject([{ errorCode: 'malware_detected', owner: 'worker' }]);
  });
});
