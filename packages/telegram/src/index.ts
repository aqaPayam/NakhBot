import { timingSafeEqual } from 'node:crypto';

import type { TelegramClientPort } from '@nakh/application';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class TelegramWebhookAuthenticator {
  public constructor(private readonly expectedSecret: string) {}

  public verify(receivedSecret: string | undefined): boolean {
    return receivedSecret !== undefined && safeEqual(receivedSecret, this.expectedSecret);
  }
}

export class UnconfiguredTelegramClient implements TelegramClientPort {
  public sendText(): Promise<void> {
    return Promise.reject(new Error('The production Telegram client is configured in M1.'));
  }
}
