import type { ReadAuditedReportPhotoHandler } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminEvidenceDelivery } from './admin-evidence-adapter.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import {
  TelegramAdminTextDelivery,
  requireTelegramAdminAcknowledgement,
} from './admin-text-delivery.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Explicit protected upload of verified held bytes. No CDN URL, caption, file cache or retry. */
export class TelegramAdminRetainedPhotoDelivery implements TelegramAdminEvidenceDelivery {
  private readonly messages: TelegramAdminTextDelivery;
  public constructor(
    private readonly botToken: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly photos: Pick<ReadAuditedReportPhotoHandler, 'read' | 'check'>,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.messages = new TelegramAdminTextDelivery(botToken, fetcher);
  }
  public text(input: Parameters<TelegramAdminEvidenceDelivery['text']>[0]): Promise<void> {
    return this.messages.text(input);
  }
  public async retainedPhoto(
    input: Parameters<TelegramAdminEvidenceDelivery['retainedPhoto']>[0],
  ): Promise<void> {
    try {
      await requireTelegramAdminSession(this.sessions, input.recipient, this.now, input.actor);
      const bytes = await this.photos.read(input);
      await this.photos.check(input);
      await requireTelegramAdminSession(this.sessions, input.recipient, this.now, input.actor);
      const body = new FormData();
      body.set('chat_id', input.recipient);
      body.set('protect_content', 'true');
      body.set('photo', new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), 'evidence.webp');
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/sendPhoto`,
        {
          method: 'POST',
          redirect: 'error',
          body,
          signal: AbortSignal.timeout(15000),
        },
      );
      await requireTelegramAdminAcknowledgement(response);
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
