import { createHash } from 'node:crypto';
import type {
  LocalizedIntent,
  RateLimiterPort,
  TelegramUserResolver,
  UserSafetyContactHandler,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { presentM7Error } from './m7-presentation.js';

export type TelegramSupportAppealResult =
  | Readonly<{ handled: false }>
  | Readonly<{ handled: true; userId: string; telegramUserId: string; notice: LocalizedIntent }>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Call only after provider webhook authentication. Actor identity is resolved server-side. */
export class TelegramSupportAppealAdapter {
  public constructor(
    private readonly botId: string,
    private readonly users: TelegramUserResolver,
    private readonly handler: Pick<UserSafetyContactHandler, 'execute'>,
    private readonly limiter: RateLimiterPort,
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Telegram bot identity is invalid.');
  }

  public async handle(update: unknown): Promise<TelegramSupportAppealResult> {
    const root = record(update);
    const message = record(root?.message);
    const match =
      typeof message?.text === 'string'
        ? /^\/(support|appeal)(?:\s+([\s\S]*))?$/u.exec(message.text)
        : null;
    if (match === null) return { handled: false };
    const from = record(message?.from);
    const chat = record(message?.chat);
    const updateId = root?.update_id;
    const sender = from?.id;
    if (
      typeof updateId !== 'number' ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const telegramUserId = String(sender);
    const userId = await this.users.resolveUserId(telegramUserId);
    if (userId === undefined)
      throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
    const bytes = createHash('sha256')
      .update(`telegram-support-appeal-v1\0${this.botId}\0${updateId}\0${userId}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 0x50;
    bytes[8] = (bytes[8]! & 63) | 0x80;
    const hex = bytes.toString('hex');
    const commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    let notice: LocalizedIntent;
    try {
      const rate = await this.limiter.consume({
        scope: 'telegram_support_appeal',
        subject: userId,
        limit: 10,
        windowSeconds: 60,
      });
      if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.m7.rate_limited', 429);
      notice = await this.handler.execute({
        userId,
        commandId,
        kind: match[1] as 'support' | 'appeal',
        text: match[2] ?? '',
      });
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      notice = presentM7Error(error);
    }
    return { handled: true, userId, telegramUserId, notice };
  }
}
