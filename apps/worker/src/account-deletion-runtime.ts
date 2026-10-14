import {
  AesGcmProfileReportSnapshotReader,
  AesGcmChatReportSnapshotReader,
  AesGcmPhotoReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotReader,
  IntegrityMessageReportSnapshotReader,
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
    if (encoded.length > 65536) throw new Error();
    const entries: unknown = JSON.parse(encoded);
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) throw new Error();
    const keys = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error();
      const item = entry as Record<string, unknown>;
      if (
        Object.keys(item).length !== 3 ||
        typeof item.keyId !== 'string' ||
        !/^[A-Za-z0-9_-]{8,160}$/u.test(item.keyId) ||
        !Number.isSafeInteger(item.keyVersion) ||
        Number(item.keyVersion) < 1 ||
        typeof item.key !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(item.key)
      )
        throw new Error();
      const key = Buffer.from(item.key, 'base64url'),
        id = `${item.keyId}\0${String(item.keyVersion)}`;
      if (key.byteLength !== 32 || key.toString('base64url') !== item.key || keys.has(id))
        throw new Error();
      keys.set(id, key);
    }
    const resolver = Object.freeze({
      resolve: (id: string, version: number): Uint8Array | undefined => {
        const key = keys.get(`${id}\0${version}`);
        return key === undefined ? undefined : Uint8Array.from(key);
      },
    });
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
