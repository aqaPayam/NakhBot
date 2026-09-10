import type {
  DownloadTelegramPhotoToQuarantine,
  RevokePhotoDeliveryCache,
  ValidateQuarantinedPhoto,
} from '@nakh/application';
import type { DomainEvent } from '@nakh/contracts';
import type { M2Metrics } from '@nakh/observability';
import type { PostgresInboxStore } from '@nakh/persistence-postgres';

type MediaHandler = Pick<DownloadTelegramPhotoToQuarantine, 'execute'>;
type ValidationHandler = Pick<ValidateQuarantinedPhoto, 'execute'>;
type CacheRevocationHandler = Pick<RevokePhotoDeliveryCache, 'execute'>;
type MediaMetrics = Pick<M2Metrics, 'recordIngestion' | 'recordQuarantineBytes'>;

function mediaAssetId(event: DomainEvent): string {
  if (
    event.aggregateType !== 'media_asset' ||
    Object.keys(event.payload).sort().join(',') !== 'assetId,validationState' ||
    event.payload.assetId !== event.aggregateId ||
    event.payload.validationState !== 'pending'
  )
    throw new Error('invalid_media_ingestion_event');
  return event.aggregateId;
}

function validationAssetId(event: DomainEvent): string {
  if (
    event.aggregateType !== 'media_asset' ||
    Object.keys(event.payload).sort().join(',') !== 'assetId,bytes' ||
    event.payload.assetId !== event.aggregateId ||
    !Number.isSafeInteger(event.payload.bytes) ||
    (event.payload.bytes as number) <= 0
  )
    throw new Error('invalid_media_validation_event');
  return event.aggregateId;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function lifecyclePhotoId(event: DomainEvent): string {
  if (
    event.aggregateType !== 'profile_photo' ||
    Object.keys(event.payload).sort().join(',') !== 'photoId,profileId' ||
    event.payload.photoId !== event.aggregateId ||
    typeof event.payload.photoId !== 'string' ||
    typeof event.payload.profileId !== 'string' ||
    !uuid.test(event.payload.photoId) ||
    !uuid.test(event.payload.profileId)
  )
    throw new Error('invalid_media_cache_revocation_event');
  return event.payload.photoId;
}

export class WorkerEventProcessor {
  public constructor(
    private readonly inbox: Pick<PostgresInboxStore, 'processSampleEvent'>,
    private readonly owner: string,
    private readonly media?: MediaHandler,
    private readonly metrics?: MediaMetrics,
    private readonly now: () => number = Date.now,
    private readonly validation?: ValidationHandler,
    private readonly cacheRevocation?: CacheRevocationHandler,
  ) {}

  public async process(event: DomainEvent): Promise<void> {
    if (event.eventType === 'platform.sample-effect-created.v1') {
      await this.inbox.processSampleEvent(event);
      return;
    }
    if (event.eventType === 'media.quarantine-uploaded.v1' && this.validation !== undefined) {
      await this.validation.execute(
        validationAssetId(event),
        `${this.owner}:validation:${event.id}`,
      );
      return;
    }
    if (
      (event.eventType === 'media.photo-hidden.v1' ||
        event.eventType === 'media.photo-deleted.v1') &&
      this.cacheRevocation !== undefined
    ) {
      await this.cacheRevocation.execute(lifecyclePhotoId(event));
      return;
    }
    if (event.eventType !== 'media.ingestion-requested.v1' || this.media === undefined)
      throw new Error('unsupported_worker_event');
    const startedAt = this.now();
    try {
      const result = await this.media.execute(
        mediaAssetId(event),
        `${this.owner}:media:${event.id}`,
      );
      if (result.bytes > 0) {
        this.metrics?.recordQuarantineBytes(result.bytes);
        this.metrics?.recordIngestion('quarantined', this.now() - startedAt);
      } else {
        this.metrics?.recordIngestion('rejected', this.now() - startedAt);
      }
    } catch (error) {
      this.metrics?.recordIngestion(
        'retryable_failure',
        this.now() - startedAt,
        'storage_unavailable',
      );
      throw error;
    }
  }
}
