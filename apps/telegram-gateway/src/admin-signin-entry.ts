import { createHash } from 'node:crypto';
import type { RateLimiterPort, UserSessionActor } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

type Identity = Readonly<{
  userId: string;
  productEpoch: number;
  uiLocale: string | null;
  notBefore: string;
}>;
type Ports = Readonly<{
  botId: string;
  limiter: RateLimiterPort;
  eligible(telegramUserId: string): Promise<Identity | undefined>;
  credential(identity: Identity, requestId: string): Promise<UserSessionActor | undefined>;
  link(actor: UserSessionActor, locale: string | null): Promise<string | undefined>;
  send(recipient: string, locale: string | null, url: string): Promise<void>;
  now?: () => Date;
}>;

/** Telegram authenticates the sender; only a pre-existing verified staff identity
 * may obtain this first factor. Product admission and MFA remain separate. */
export class TelegramAdministratorSignIn {
  public constructor(private readonly ports: Ports) {}
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    if (update === null || typeof update !== 'object') return 'unhandled';
    const body = update as Record<string, unknown>;
    const message = body.message as Record<string, unknown> | undefined;
    if (message?.text !== '/admin_signin') return 'unhandled';
    const sender = message.from as Record<string, unknown> | undefined;
    const chat = message.chat as Record<string, unknown> | undefined;
    const positive = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    if (
      !positive(sender?.id) ||
      sender.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender.id ||
      !positive(message.message_id) ||
      !positive(message.date) ||
      typeof body.update_id !== 'number' ||
      !Number.isSafeInteger(body.update_id) ||
      body.update_id < 0 ||
      body.callback_query !== undefined ||
      body.edited_message !== undefined
    )
      return 'notice';
    // Capture provider primitives before any await. Never replace a provider
    // timestamp or derive the retry identity from a later product epoch.
    const recipient = String(sender.id),
      at = message.date * 1000;
    const digest = createHash('sha256')
      .update(`admin-signin:${this.ports.botId}:${recipient}:${body.update_id}`)
      .digest()
      .subarray(0, 16);
    digest[6] = (digest[6]! & 15) | 80;
    digest[8] = (digest[8]! & 63) | 128;
    const hex = digest.toString('hex');
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const fresh = (identity?: Identity): boolean => {
      const now = (this.ports.now?.() ?? new Date()).getTime();
      return (
        at <= now &&
        now - at <= 120000 &&
        (identity === undefined || at > Date.parse(identity.notBefore))
      );
    };
    if (!fresh()) return 'notice';
    if (
      !(
        await this.ports.limiter.consume({
          scope: 'telegram_admin_signin',
          subject: recipient,
          limit: 5,
          windowSeconds: 60,
        })
      ).allowed
    )
      return 'notice';
    const found = await this.ports.eligible(recipient);
    if (found === undefined) return 'notice';
    const original = Object.freeze({ ...found });
    if (!fresh(original)) return 'notice';
    const actor = await this.ports.credential(original, requestId);
    if (
      actor === undefined ||
      actor.kind !== 'user' ||
      actor.userId !== original.userId ||
      actor.productEpoch !== original.productEpoch ||
      typeof actor.sessionGrantId !== 'string'
    )
      return 'notice';
    const current = await this.ports.eligible(recipient);
    if (
      current === undefined ||
      current.userId !== original.userId ||
      current.productEpoch !== original.productEpoch ||
      !fresh(current)
    )
      return 'notice';
    const url = await this.ports.link(actor, original.uiLocale);
    if (url !== undefined && fresh(current)) {
      try {
        await this.ports.send(recipient, original.uiLocale, url);
      } catch {
        throw new ApplicationError('internal_error', 'error.identity.user_context_invalid', 500);
      }
    }
    return 'notice';
  }
}
