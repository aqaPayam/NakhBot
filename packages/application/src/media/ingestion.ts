import type {
  BeginTelegramPhotoIngestionCommand,
  BeginPhotoIngestionResult,
} from '@nakh/contracts';

/** Internal persistence input. PR3 supplies authenticated transport and authenticated encryption.
 * Never pass raw Telegram identifiers into ciphertext or expose this write as a public route. */
export type BeginMediaIngestionWrite = Readonly<{
  command: BeginTelegramPhotoIngestionCommand;
  transportMetadataCiphertext: Uint8Array;
  assetId: string;
  auditId: string;
  eventId: string;
}>;

export interface MediaIngestionStore {
  beginTelegramIngestion(write: BeginMediaIngestionWrite): Promise<BeginPhotoIngestionResult>;
}
