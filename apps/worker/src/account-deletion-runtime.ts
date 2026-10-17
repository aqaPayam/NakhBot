import {
  AesGcmProfileReportSnapshotReader,
  AesGcmChatReportSnapshotReader,
  AesGcmPhotoReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotReader,
  IntegrityMessageReportSnapshotReader,
  ReportSnapshotKeyRing,
  ExecuteAccountDeletionMedia,
  ExecuteAccountDeletionEphemeral,
  RunAccountDeletionBatchHandler,
  type AccountDeletionMediaObjects,
  type AccountDeletionMediaCache,
  type AccountDeletionEphemeralProvider,
} from '@nakh/application';
import {
  PostgresAccountDeletionWorkStore,
  PostgresAccountDeletionMediaStore,
  PostgresAccountDeletionEphemeralStore,
  PostgresAccountDeletionSessionStore,
  PostgresAccountDeletionPhaseExecutor,
  type NakhDatabase,
  type ReportEvidenceReaders,
} from '@nakh/persistence-postgres';

/** Preload active and historical decryption keys before any native transaction.
 * Invalid configuration never echoes JSON or secret material into startup logs. */
export function loadDeletionEvidenceReaders(encoded: string): ReportEvidenceReaders {
  try {
    const resolver = new ReportSnapshotKeyRing(encoded);
    return Object.freeze({
      profile: new AesGcmProfileReportSnapshotReader(resolver),
      chat: new AesGcmChatReportSnapshotReader(resolver),
      photo: new AesGcmPhotoReportSnapshotReader(resolver),
      unmatched_user: new AesGcmUnmatchedReportSnapshotReader(resolver),
      message: new IntegrityMessageReportSnapshotReader(),
    });
  } catch {
    throw new Error('Deletion evidence key configuration unavailable.');
  }
}

export function createAccountDeletionRuntime(
  input: Readonly<{
    database: NakhDatabase;
    readers: ReportEvidenceReaders;
    objects: AccountDeletionMediaObjects;
    cache: AccountDeletionMediaCache;
    ephemeralProvider: AccountDeletionEphemeralProvider;
    prefix: string;
    cutoverEvidenceHash: string;
    workerId: string;
    environment: 'development' | 'test' | 'staging' | 'production';
  }>,
): RunAccountDeletionBatchHandler {
  const media = new ExecuteAccountDeletionMedia(
    new PostgresAccountDeletionMediaStore(input.database, input.environment),
    input.objects,
    input.cache,
    input.environment,
  );
  const ephemeral = new ExecuteAccountDeletionEphemeral(
    new PostgresAccountDeletionEphemeralStore(
      input.database,
      input.prefix,
      input.cutoverEvidenceHash,
    ),
    new PostgresAccountDeletionSessionStore(input.database),
    input.ephemeralProvider,
  );
  return new RunAccountDeletionBatchHandler(
    new PostgresAccountDeletionWorkStore(input.database),
    new PostgresAccountDeletionPhaseExecutor(
      input.database,
      input.readers,
      media,
      ephemeral,
      input.environment,
    ),
    input.workerId,
  );
}
