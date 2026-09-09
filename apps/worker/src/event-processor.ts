import type { DownloadTelegramPhotoToQuarantine } from '@nakh/application';
import type { DomainEvent } from '@nakh/contracts';
import type { M2Metrics } from '@nakh/observability';
import type { PostgresInboxStore } from '@nakh/persistence-postgres';

type MediaHandler = Pick<DownloadTelegramPhotoToQuarantine, 'execute'>;
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

export class WorkerEventProcessor {
  public constructor(
    private readonly inbox: Pick<PostgresInboxStore, 'processSampleEvent'>,
    private readonly owner: string,
    private readonly media?: MediaHandler,
    private readonly metrics?: MediaMetrics,
    private readonly now: () => number = Date.now,
  ) {}

  public async process(event: DomainEvent): Promise<void> {
    if (event.eventType === 'platform.sample-effect-created.v1') {
      await this.inbox.processSampleEvent(event);
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
