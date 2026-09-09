import { MEDIA_LIMITS } from '@nakh/domain';

import {
  boundedMediaStream,
  MediaDownloadError,
  MediaScanError,
  scannedMediaStream,
  type MalwareScanSession,
  type MalwareScannerPort,
  type QuarantineAssetStore,
  type QuarantineObjectPort,
  type TelegramMediaPort,
} from './ingestion.js';

export type QuarantineDownloadResult = Readonly<{
  assetId: string;
  bytes: number;
  sha256: string;
}>;

export class DownloadTelegramPhotoToQuarantine {
  public constructor(
    private readonly assets: QuarantineAssetStore,
    private readonly telegram: TelegramMediaPort,
    private readonly objects: QuarantineObjectPort,
    private readonly scanner: MalwareScannerPort,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 120_000,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 900_000)
      throw new Error('invalid media ingestion lease duration');
  }

  public async execute(
    assetId: string,
    owner: string,
    signal?: AbortSignal,
  ): Promise<QuarantineDownloadResult> {
    const deadline = AbortSignal.timeout(Math.min(90_000, this.leaseMs - 20_000));
    const operationSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const cleanupSignal = (): AbortSignal => AbortSignal.timeout(15_000);
    const asset = await this.assets.claimPendingQuarantine({
      assetId,
      owner,
      leaseMs: this.leaseMs,
    });
    if (asset === undefined) throw new Error('pending media asset not found');
    if (asset.completed !== undefined) return { assetId, ...asset.completed };
    if (asset.telegramFileId === undefined) {
      await this.assets.releaseQuarantineClaim(assetId, owner);
      throw new Error('media transport unavailable');
    }
    const download = await this.telegram.download(asset.telegramFileId, operationSignal);
    if (
      download.contentLength !== undefined &&
      (!Number.isSafeInteger(download.contentLength) ||
        download.contentLength <= 0 ||
        download.contentLength > MEDIA_LIMITS.maximumUploadBytes)
    ) {
      await download.cancel?.();
      await this.assets.markDownloadRejected({
        assetId,
        errorCode:
          download.contentLength > MEDIA_LIMITS.maximumUploadBytes
            ? 'media_too_large'
            : 'media_download_invalid',
        failedAt: this.now(),
        owner,
      });
      return { assetId, bytes: 0, sha256: '' };
    }
    let scan: MalwareScanSession;
    try {
      scan = await this.scanner.start(operationSignal);
    } catch (error) {
      await this.assets.releaseQuarantineClaim(assetId, owner);
      throw error;
    }
    try {
      const stored = await this.objects.put({
        key: asset.quarantineKey,
        body: scannedMediaStream(
          boundedMediaStream(
            download.body,
            MEDIA_LIMITS.maximumUploadBytes,
            download.contentLength,
          ),
          scan,
        ),
        contentType: 'application/octet-stream',
        signal: operationSignal,
      });
      if (
        !Number.isSafeInteger(stored.bytes) ||
        stored.bytes <= 0 ||
        stored.bytes > MEDIA_LIMITS.maximumUploadBytes ||
        !/^[a-f0-9]{64}$/u.test(stored.sha256)
      ) {
        throw new MediaDownloadError('media_download_invalid');
      }
      let verdict;
      try {
        verdict = await scan.complete();
      } catch {
        throw new MediaScanError();
      }
      if (verdict.result === 'detected') {
        await this.objects.delete(asset.quarantineKey, cleanupSignal());
        await this.assets.markDownloadRejected({
          assetId,
          errorCode: 'malware_detected',
          failedAt: this.now(),
          owner,
        });
        return { assetId, bytes: 0, sha256: '' };
      }
      await this.assets.markQuarantineUploaded({
        assetId,
        bytes: stored.bytes,
        sha256: stored.sha256,
        uploadedAt: this.now(),
        owner,
        scannerVersion: verdict.scannerVersion,
        signatureVersion: verdict.signatureVersion,
        scannedAt: this.now(),
      });
      return { assetId, ...stored };
    } catch (error) {
      if (error instanceof MediaDownloadError || error instanceof MediaScanError) {
        // A failed cleanup must remain retryable; never silently strand a partial object.
        await this.objects.delete(asset.quarantineKey, cleanupSignal());
        if (error instanceof MediaDownloadError) {
          await this.assets.markDownloadRejected({
            assetId,
            errorCode: error.code,
            failedAt: this.now(),
            owner,
          });
          return { assetId, bytes: 0, sha256: '' };
        }
        await this.assets.releaseQuarantineClaim(assetId, owner);
        throw error;
      }
      // Provider/storage/database failures stay retryable. An object may exist; a later
      // attempt reconciles it by HEAD and the database never marks it published here.
      await this.assets.releaseQuarantineClaim(assetId, owner);
      throw error;
    } finally {
      await scan.abort().catch(() => undefined);
      await download.cancel?.();
    }
  }
}
