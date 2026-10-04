import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminEvidenceDelivery } from './admin-evidence-adapter.js';
import { m7Record } from './m7-private-update.js';
import type {
  TelegramAdminQueueMenu,
  TelegramAdminQueueDelivery,
} from './admin-safety-queue-menu.js';
import type {
  TelegramAdminReadConfirmationMenu,
  TelegramAdminReadMenuDelivery,
} from './admin-read-confirmation-menu.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
function unavailable(): ApplicationError {
  return new ApplicationError('internal_error', 'error.m7.internal', 500);
}
async function requireAcknowledgement(response: Response): Promise<number> {
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
    return messageId;
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
export class TelegramAdminTextDelivery
  implements
    Pick<TelegramAdminEvidenceDelivery, 'text'>,
    TelegramAdminReadMenuDelivery,
    TelegramAdminQueueDelivery
{
  public constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
  ) {
    if (botToken.length < 1 || botToken.length > 256 || !/^[A-Za-z0-9:_-]+$/u.test(botToken))
      throw new Error('Telegram admin delivery configuration invalid.');
  }
  public async text(input: Parameters<TelegramAdminEvidenceDelivery['text']>[0]): Promise<void> {
    await this.send(input);
  }
  public async supportMutationMenu(input: TelegramAdminReadConfirmationMenu): Promise<void> {
    return this.confirmationMenu(input, 'm7m:', 'm7x:');
  }
  public async menu(input: TelegramAdminReadConfirmationMenu): Promise<void> {
    return this.confirmationMenu(input, 'm7s:', 'm7c:');
  }
  private async confirmationMenu(
    input: TelegramAdminReadConfirmationMenu,
    confirm: string,
    cancel: string,
  ): Promise<void> {
    const rows = input.replyMarkup.inline_keyboard;
    const buttons = rows[0];
    if (
      rows.length !== 1 ||
      buttons.length !== 2 ||
      buttons.some((button) => button.text.trim() === '' || [...button.text].length > 64) ||
      !new RegExp(`^${confirm}[A-Za-z0-9_-]{22}$`, 'u').test(buttons[0].callback_data) ||
      buttons[1].callback_data !== buttons[0].callback_data.replace(confirm, cancel)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    await this.send(input, {
      inline_keyboard: [
        [
          { text: buttons[0].text, callback_data: buttons[0].callback_data },
          { text: buttons[1].text, callback_data: buttons[1].callback_data },
        ],
      ],
    });
  }
  public async queueMenu(input: TelegramAdminQueueMenu): Promise<void> {
    const rows = input.replyMarkup.inline_keyboard;
    if (
      rows.length < 1 ||
      rows.length > 11 ||
      rows.some(
        (row) =>
          row.length !== 1 ||
          row[0].text.trim() === '' ||
          [...row[0].text].length > 64 ||
          !/^m7[qpvjk]:[A-Za-z0-9_-]{22}$/u.test(row[0].callback_data),
      )
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    await this.send(input, {
      inline_keyboard: rows.map((row) => [
        { text: row[0].text, callback_data: row[0].callback_data },
      ]),
    });
  }
  public async reasonPrompt(
    input: Readonly<{ recipient: string; text: string; disableLinkPreviews: true }>,
  ): Promise<number> {
    return this.send(input, { force_reply: true, selective: true });
  }
  private async send(
    input: Parameters<TelegramAdminEvidenceDelivery['text']>[0],
    replyMarkup?:
      | TelegramAdminReadConfirmationMenu['replyMarkup']
      | TelegramAdminQueueMenu['replyMarkup']
      | Readonly<{ force_reply: true; selective: true }>,
  ): Promise<number> {
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
            ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      return await requireAcknowledgement(response);
    } catch {
      throw unavailable();
    }
  }
}
