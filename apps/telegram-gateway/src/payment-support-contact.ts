import { createHash } from 'node:crypto';
import type { RateLimiterPort } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

type Ports = Readonly<{
  botId: string;
  username: string;
  limiter: RateLimiterPort;
  send(recipient: string, username: string): Promise<void>;
}>;
function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
/** Public contact only: never resolves an account, creates a grant, forwards
 * a message body, records payment details or acknowledges a support write. */
export class TelegramPaymentSupportContact {
  private readonly botId: string;
  private readonly username: string;
  private readonly consume: RateLimiterPort['consume'];
  private readonly send: Ports['send'];
  public constructor(ports: Ports) {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(ports.botId) ||
      !Number.isSafeInteger(Number(ports.botId)) ||
      !/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(ports.username)
    )
      throw new Error('Public support contact configuration unavailable.');
    this.botId = ports.botId;
    this.username = ports.username;
    this.consume = ports.limiter.consume.bind(ports.limiter);
    this.send = ports.send.bind(ports);
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = object(update),
      message = object(root?.message);
    if (typeof message?.text !== 'string' || !/^\/paysupport(?:\s|$)/u.test(message.text))
      return 'unhandled';
    const from = object(message.from),
      chat = object(message.chat);
    const sender = from?.id,
      id = root?.update_id;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 0 ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const recipient = String(sender),
      username = this.username;
    try {
      const rate = await this.consume({
        scope: 'telegram_payment_support_contact',
        subject: createHash('sha256')
          .update(this.botId + '\0' + recipient)
          .digest('hex'),
        limit: 10,
        windowSeconds: 60,
      });
      if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.m7.rate_limited', 429);
      await this.send(recipient, username);
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'rate_limited')
        throw new ApplicationError('rate_limited', 'error.m7.rate_limited', 429);
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
