import type { NotificationProviderFailureCode } from '@nakh/domain';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TelegramNotificationFailureCode = NotificationProviderFailureCode;

const FAILURE_CODES = new Set<TelegramNotificationFailureCode>([
  'rate_limited',
  'provider_unavailable',
  'network_error',
  'bot_blocked',
  'recipient_unavailable',
  'provider_request_invalid',
  'ambiguous_result',
]);

/** Finite, sanitized failure. Telegram response bodies and token-bearing URLs are never retained. */
export class TelegramNotificationSendFailure extends Error {
  public constructor(
    public readonly reasonCode: TelegramNotificationFailureCode,
    public readonly retryAfterMs?: number,
  ) {
    super('Telegram notification delivery unavailable.');
    if (
      !FAILURE_CODES.has(reasonCode) ||
      (retryAfterMs !== undefined &&
        (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 900_000))
    )
      throw new Error('Invalid Telegram notification failure.');
  }
}

type TelegramResponse = Readonly<{
  ok?: unknown;
  error_code?: unknown;
  description?: unknown;
  parameters?: unknown;
  result?: unknown;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderTelegramNotification(title: string, body: string): string {
  if (title.trim() === '' || body.trim() === '')
    throw new TelegramNotificationSendFailure('provider_request_invalid');
  const rendered = `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`;
  if ([...rendered].length > 4096)
    throw new TelegramNotificationSendFailure('provider_request_invalid');
  return rendered;
}

async function readBoundedJson(response: Response): Promise<TelegramResponse | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) return undefined;
      bytes += chunk.byteLength;
      if (bytes > 65_536) return undefined;
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* The response stream may already be closed. */
    }
    reader.releaseLock();
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return undefined;
  }
}

function classifyKnownFailure(status: number, payload: TelegramResponse | undefined): never {
  const errorCode = typeof payload?.error_code === 'number' ? payload.error_code : status;
  if (errorCode === 429) {
    const retryAfter = record(payload?.parameters)?.retry_after;
    const retryAfterMs =
      typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter * 1000, 900_000)
        : undefined;
    throw new TelegramNotificationSendFailure('rate_limited', retryAfterMs);
  }
  if (errorCode === 403) throw new TelegramNotificationSendFailure('bot_blocked');
  if (errorCode === 400) {
    const description =
      typeof payload?.description === 'string' ? payload.description.toLowerCase() : '';
    if (description.includes('chat not found') || description.includes('user is deactivated'))
      throw new TelegramNotificationSendFailure('recipient_unavailable');
    throw new TelegramNotificationSendFailure('provider_request_invalid');
  }
  if (errorCode === 401) throw new TelegramNotificationSendFailure('provider_request_invalid');
  throw new TelegramNotificationSendFailure('provider_unavailable');
}

/** Sends one fully rendered notification without exposing Telegram identity outside this adapter. */
export class TelegramNotificationSender {
  public constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
    private readonly apiOrigin = 'https://api.telegram.org',
  ) {
    if (botToken.trim() === '') throw new Error('Telegram bot token is required.');
    if (apiOrigin !== 'https://api.telegram.org') throw new Error('Telegram API origin is fixed.');
  }

  public async send(
    input: Readonly<{
      telegramUserId: string;
      title: string;
      body: string;
    }>,
  ): Promise<Readonly<{ providerMessageKey: string }>> {
    if (!/^[1-9][0-9]{0,19}$/u.test(input.telegramUserId))
      throw new TelegramNotificationSendFailure('recipient_unavailable');
    const text = renderTelegramNotification(input.title, input.body);
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiOrigin}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: input.telegramUserId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new TelegramNotificationSendFailure('ambiguous_result');
    }

    const payload = await readBoundedJson(response);
    if (!response.ok || payload?.ok !== true) {
      if (response.ok && payload === undefined)
        throw new TelegramNotificationSendFailure('ambiguous_result');
      classifyKnownFailure(response.status, payload);
    }
    const messageId = record(payload.result)?.message_id;
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1)
      throw new TelegramNotificationSendFailure('ambiguous_result');
    return { providerMessageKey: `telegram:${messageId}` };
  }
}
