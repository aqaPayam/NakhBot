import type {
  AccountDeletionLease,
  AccountDeletionPhaseExecutor,
  AccountDeletionStepOutcome,
  ExecuteAccountDeletionMedia,
  ExecuteAccountDeletionEphemeral,
} from '@nakh/application';
import { ApplicationError, ACCOUNT_DELETION_PHASES } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import type { ReportEvidenceReaders } from './report-capture-integrity.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionEvidenceStore } from './account-deletion-evidence-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionPhotoStore } from './account-deletion-photo-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionMediaStore } from './account-deletion-media-store.js';
import { PostgresAccountDeletionRetentionStore } from './account-deletion-retention-store.js';
import { PostgresAccountDeletionOperationalStore } from './account-deletion-operational-store.js';
import { PostgresAccountDeletionNoticeStore } from './account-deletion-notice-store.js';
import { PostgresAccountDeletionSupportStore } from './account-deletion-support-store.js';
import { PostgresAccountDeletionPaidPendingStore } from './account-deletion-paid-pending-store.js';
import { PostgresAccountDeletionTerminalPendingStore } from './account-deletion-terminal-pending-store.js';
import { PostgresAccountDeletionNakhStore } from './account-deletion-nakh-store.js';
import { PostgresAccountDeletionFlowStore } from './account-deletion-flow-store.js';
import { PostgresAccountDeletionReferencedLikeStore } from './account-deletion-referenced-like-store.js';
import { PostgresAccountDeletionOwnedUnlockStore } from './account-deletion-unlock-store.js';
import { PostgresAccountDeletionLikeStore } from './account-deletion-like-store.js';
import { PostgresAccountDeletionPairStore } from './account-deletion-pair-store.js';
import { PostgresAccountDeletionTransportStore } from './account-deletion-transport-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';
import { PostgresAccountDeletionFinancialStore } from './account-deletion-financial-store.js';

/** Fixed dependency order, one effective bounded store/provider operation per
 * poll. Empty or blocked resource checks never constitute phase completion.
 * Independent native checkpoint functions remain the only advancement authority. */
export class PostgresAccountDeletionPhaseExecutor implements AccountDeletionPhaseExecutor {
  private readonly checkpoints: PostgresAccountDeletionCheckpointStore;
  private readonly evidence: PostgresAccountDeletionEvidenceStore;
  public constructor(
    private readonly database: NakhDatabase,
    readers: ReportEvidenceReaders,
    private readonly media: Pick<ExecuteAccountDeletionMedia, 'executeNext'>,
    private readonly ephemeral: Pick<ExecuteAccountDeletionEphemeral, 'executeNext'>,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {
    this.checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    this.evidence = new PostgresAccountDeletionEvidenceStore(database, readers);
  }
  public async executeNext(lease: AccountDeletionLease): Promise<AccountDeletionStepOutcome> {
    const index = ACCOUNT_DELETION_PHASES.indexOf(lease.phase);
    if (index < 0 || lease.phase === 'completed' || lease.checkpointVersion !== index + 1)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    switch (lease.phase) {
      case 'shared_closure': {
        const batch = await new PostgresAccountDeletionSharedStore(this.database).closeNext(lease);
        if (batch.changed) return 'progress';
        if (batch.hasMore) return 'waiting';
        await this.checkpoints.finishShared(lease);
        return 'advanced';
      }
      case 'evidence_capture':
        return this.capture(lease);
      case 'product_data':
        return this.purge(lease);
      case 'media_objects': {
        if ((await this.media.executeNext(lease)).worked) return 'progress';
        const batch = await new PostgresAccountDeletionMediaStore(
          this.database,
          this.environment,
        ).archiveNext(lease);
        if (batch.archived) return 'progress';
        return (await this.checkpoints.finishMedia(lease)).phase === 'ephemeral_access'
          ? 'advanced'
          : 'waiting';
      }
      case 'ephemeral_access':
      case 'verification': {
        const result = await this.ephemeral.executeNext(lease);
        return result.completed
          ? lease.phase === 'verification'
            ? 'completed'
            : 'advanced'
          : result.worked
            ? 'progress'
            : 'waiting';
      }
      case 'retention_manifest': {
        const store = new PostgresAccountDeletionRetentionStore(this.database);
        if ((await store.recordNext(lease)).hasMore) return 'progress';
        return (await store.finish(lease)).completed ? 'advanced' : 'waiting';
      }
    }
  }
  private async capture(lease: AccountDeletionLease): Promise<AccountDeletionStepOutcome> {
    const verified = await this.evidence.verifyNext(lease);
    if (verified.waitingForCapture || (verified.examined > 0 && !verified.verified))
      return 'waiting';
    if (verified.examined > 0 || verified.hasMore) return 'progress';
    for (const store of [
      new PostgresAccountDeletionChatStore(this.database),
      new PostgresAccountDeletionMatchStore(this.database),
      new PostgresAccountDeletionPhotoStore(this.database),
    ]) {
      const batch = await store.archiveNext(lease);
      if (batch.waitingForCapture) return 'waiting';
      if (
        batch.archived ||
        batch.hasMore ||
        ('deletedMessages' in batch &&
          typeof batch.deletedMessages === 'number' &&
          batch.deletedMessages > 0)
      )
        return 'progress';
    }
    const profile = await new PostgresAccountDeletionProfileStore(this.database).archive(lease);
    if (profile.waitingForCapture) return 'waiting';
    if (profile.archived) return 'progress';
    return (await this.checkpoints.finishEvidence(lease)).phase === 'product_data'
      ? 'advanced'
      : 'waiting';
  }
  private async purge(lease: AccountDeletionLease): Promise<AccountDeletionStepOutcome> {
    const publication = await new PostgresAccountDeletionOperationalStore(this.database).cancelNext(
      lease,
    );
    if (publication.cancelledRows > 0) return 'progress';
    const support = await new PostgresAccountDeletionSupportStore(this.database).closeNext(lease);
    if (support.closed) return 'progress';
    for (const store of [
      new PostgresAccountDeletionNoticeStore(this.database),
      new PostgresAccountDeletionPaidPendingStore(this.database),
      new PostgresAccountDeletionTerminalPendingStore(this.database),
      new PostgresAccountDeletionNakhStore(this.database),
      new PostgresAccountDeletionFlowStore(this.database),
      new PostgresAccountDeletionReferencedLikeStore(this.database),
      new PostgresAccountDeletionOwnedUnlockStore(this.database),
      new PostgresAccountDeletionLikeStore(this.database),
      new PostgresAccountDeletionPairStore(this.database),
      new PostgresAccountDeletionTransportStore(this.database),
      new PostgresAccountDeletionProductStore(this.database),
    ]) {
      if ((await store.purgeNext(lease)).purgedRows > 0) return 'progress';
    }
    await new PostgresAccountDeletionFinancialStore(this.database).prepareCreditEpoch(lease);
    return (await this.checkpoints.finishProduct(lease)).phase === 'media_objects'
      ? 'advanced'
      : 'waiting';
  }
}
