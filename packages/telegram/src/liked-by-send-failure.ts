export type TelegramLikedByProviderFailureCode =
  'media_unavailable' | 'provider_timeout' | 'provider_rejected' | 'provider_unavailable';

const FAILURE_CODES = new Set<TelegramLikedByProviderFailureCode>([
  'media_unavailable',
  'provider_timeout',
  'provider_rejected',
  'provider_unavailable',
]);

/** Safe, bounded channel error; provider response bodies and request URLs stay out of logs. */
export class TelegramLikedBySendFailure extends Error {
  public constructor(
    public readonly reasonCode: TelegramLikedByProviderFailureCode,
    public readonly retryAfterMs?: number,
  ) {
    super('Telegram locked-card delivery unavailable.');
    if (
      !FAILURE_CODES.has(reasonCode) ||
      (retryAfterMs !== undefined &&
        (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 3_600_000))
    )
      throw new Error('Invalid Telegram delivery failure.');
  }
}
