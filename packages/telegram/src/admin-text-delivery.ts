import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminEvidenceDelivery } from './admin-evidence-adapter.js';
import { m7Record } from './m7-private-update.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
function unavailable(): ApplicationError {
  return new ApplicationError('internal_error', 'error.m7.internal', 500);
}
async function requireAcknowledgement(response: Response): Promise<void> {
  if (response.body === null) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw unavailable();
      size += chunk.byteLength;
      if (size > 65536) throw unavailable();
      chunks.push(chunk);
    }
    const payload = m7Record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    const messageId = m7Record(payload?.result)?.message_id;
    if (
      !response.ok ||
      payload?.ok !== true ||
      typeof messageId !== 'number' ||
      !Number.isSafeInteger(messageId) ||
      messageId < 1
    )
      throw unavailable();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Never expose provider stream diagnostics. */
    }
    reader.releaseLock();
  }
}
/** One protected plain-text send to the fixed Bot API. No persistence, tracing, or retry.
 * A failed/ambiguous send requires a new confirmed audited read, never a replayed read. */
export class TelegramAdminTextDelivery implements Pick<TelegramAdminEvidenceDelivery, 'text'> {
  public constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
  ) {
    if (botToken.length < 1 || botToken.length > 256 || !/^[A-Za-z0-9:_-]+$/u.test(botToken))
      throw new Error('Telegram admin delivery configuration invalid.');
  }
  public async text(input: Parameters<TelegramAdminEvidenceDelivery['text']>[0]): Promise<void> {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(input.recipient) ||
      input.text.length < 1 ||
      input.text.length > 3500 ||
      input.disableLinkPreviews !== true
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: input.recipient,
            text: input.text,
            link_preview_options: { is_disabled: true },
            protect_content: true,
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      await requireAcknowledgement(response);
    } catch {
      throw unavailable();
    }
  }
}
