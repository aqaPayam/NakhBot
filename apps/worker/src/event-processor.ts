import type {
  DeletePhotoMediaObjects,
  DownloadTelegramPhotoToQuarantine,
  RevokePhotoDeliveryCache,
  SettlePendingNakhesHandler,
  ValidateQuarantinedPhoto,
} from '@nakh/application';
import type { DomainEvent } from '@nakh/contracts';
import type { M2Metrics, M5Metrics } from '@nakh/observability';
import type { PostgresInboxStore } from '@nakh/persistence-postgres';

type MediaHandler = Pick<DownloadTelegramPhotoToQuarantine, 'execute'>;
type ValidationHandler = Pick<ValidateQuarantinedPhoto, 'execute'>;
type CacheRevocationHandler = Pick<RevokePhotoDeliveryCache, 'execute'>;
type MediaCleanupHandler = Pick<DeletePhotoMediaObjects, 'execute'>;
type PendingNakhSettlementHandler = Pick<SettlePendingNakhesHandler, 'execute'>;
type MediaMetrics = Pick<M2Metrics, 'recordIngestion' | 'recordQuarantineBytes'> &
  Partial<Pick<M2Metrics, 'recordCleanup'>>;
type NakhMetrics = Pick<M5Metrics, 'recordDelivery' | 'recordSettlement'>;

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

function creditIncrease(event: DomainEvent): Readonly<{
  senderUserId: string;
  triggerCreditTransactionId: string;
}> {
  if (
    event.aggregateType !== 'credit_account' ||
    !uuid.test(event.aggregateId) ||
    Object.keys(event.payload).sort().join(',') !== 'amount,balanceAfter,creditTransactionId' ||
    typeof event.payload.creditTransactionId !== 'string' ||
    !uuid.test(event.payload.creditTransactionId) ||
    typeof event.payload.amount !== 'string' ||
    !/^[1-9][0-9]*$/u.test(event.payload.amount) ||
    typeof event.payload.balanceAfter !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(event.payload.balanceAfter)
  )
    throw new Error('invalid_credit_increase_event');
  return {
    senderUserId: event.aggregateId,
    triggerCreditTransactionId: event.payload.creditTransactionId,
  };
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
    private readonly mediaCleanup?: MediaCleanupHandler,
    private readonly pendingNakhSettlement?: PendingNakhSettlementHandler,
    private readonly nakhMetrics?: NakhMetrics,
  ) {}

  public async process(event: DomainEvent): Promise<void> {
    if (event.eventType === 'platform.sample-effect-created.v1') {
      await this.inbox.processSampleEvent(event);
      return;
    }
    if (
      event.eventType === 'billing.credit-increased.v1' &&
      this.pendingNakhSettlement !== undefined
    ) {
      const startedAt = this.now();
      let result;
      try {
        result = await this.pendingNakhSettlement.execute({
          ...creditIncrease(event),
          causationId: event.id,
        });
      } catch (error) {
        this.nakhMetrics?.recordSettlement('failure', this.now() - startedAt);
        throw error;
      }
      const durationMs = this.now() - startedAt;
      this.nakhMetrics?.recordSettlement(
        result.stopped,
        durationMs,
        result.deliveredCount,
        result.closedCount,
      );
      if (result.deliveredCount > 0)
        this.nakhMetrics?.recordDelivery('delivered', 'credits', durationMs, result.deliveredCount);
      if (result.closedCount > 0)
        this.nakhMetrics?.recordDelivery('closed', 'credits', durationMs, result.closedCount);
      if (result.stopped === 'external_funding')
        throw new Error('pending_nakh_external_funding_in_progress');
      if (result.stopped === 'queue_bound')
        throw new Error('pending_nakh_settlement_pass_incomplete');
      return;
    }
    if (event.eventType === 'media.quarantine-uploaded.v1' && this.validation !== undefined) {
      await this.validation.execute(
        validationAssetId(event),
        `${this.owner}:validation:${event.id}`,
      );
      return;
    }
    if (event.eventType === 'media.photo-hidden.v1' && this.cacheRevocation !== undefined) {
      await this.cacheRevocation.execute(lifecyclePhotoId(event));
      return;
    }
    if (
      event.eventType === 'media.photo-deleted.v1' &&
      (this.cacheRevocation !== undefined || this.mediaCleanup !== undefined)
    ) {
      const photoId = lifecyclePhotoId(event);
      const startedAt = this.now();
      try {
        await this.cacheRevocation?.execute(photoId);
        await this.mediaCleanup?.execute(photoId, `${this.owner}:cleanup:${event.id}`);
        if (this.mediaCleanup !== undefined)
          this.metrics?.recordCleanup?.('succeeded', this.now() - startedAt);
      } catch (error) {
        if (this.mediaCleanup !== undefined)
          this.metrics?.recordCleanup?.('retryable_failure', this.now() - startedAt);
        throw error;
      }
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
