import { ReadAuditedReportPhotoHandler, type ReportPhotoObjectReader } from '@nakh/application';
import { PostgresAuditedReportPhotoStore, type NakhDatabase } from '@nakh/persistence-postgres';
import {
  TelegramAdminRetainedPhotoDelivery,
  type TelegramAdminSessionVerifier,
} from '@nakh/telegram';

/** Explicit storage/session composition. Ordinary startup never substitutes a no-op or public URL. */
export function createTelegramAdminEvidenceDelivery(
  input: Readonly<{
    database: NakhDatabase;
    objects: ReportPhotoObjectReader;
    sessions: TelegramAdminSessionVerifier;
    botToken: string;
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  }>,
): TelegramAdminRetainedPhotoDelivery {
  return new TelegramAdminRetainedPhotoDelivery(
    input.botToken,
    input.sessions,
    new ReadAuditedReportPhotoHandler(
      new PostgresAuditedReportPhotoStore(input.database),
      input.objects,
    ),
    input.fetcher,
  );
}
