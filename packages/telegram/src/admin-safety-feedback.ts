import { createHmac } from 'node:crypto';
import type { OpaqueTokenStore } from '@nakh/application';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { TelegramAdminEvidenceDelivery } from './admin-evidence-adapter.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import { presentM7Error, type M7TextRenderer } from './m7-presentation.js';

export interface TelegramAdminSafetyHandler {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}
function expected(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError && [400, 401, 403, 404, 409, 429].includes(error.status);
}
function unavailable(): ApplicationError {
  return new ApplicationError('internal_error', 'error.m7.internal', 500);
}

/** Authenticated webhook composition for read UI only. Expected rejections are acknowledged;
 * fixed catalog feedback goes only to a current bound private admin session. Notice receipts
 * never short-circuit a native handler, authorize a read or replace any native attempt/access audit. */
export class TelegramAdminSafetyFeedback implements TelegramAdminSafetyHandler {
  private readonly key: Uint8Array;
  public constructor(
    private readonly botId: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly handlers: readonly TelegramAdminSafetyHandler[],
    private readonly tokens: OpaqueTokenStore,
    key: Uint8Array,
    private readonly delivery: Pick<TelegramAdminEvidenceDelivery, 'text'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(botId) ||
      !Number.isSafeInteger(Number(botId)) ||
      key.byteLength < 32
    )
      throw new Error('Admin feedback configuration invalid.');
    this.key = Uint8Array.from(key);
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = m7Record(update),
      message = m7Record(root?.message),
      callback = m7Record(root?.callback_query);
    const data = callback?.data;
    const adminCallback =
      typeof data === 'string' && /^m7[qpscvjkmxabdzuhnTOFYIDAGZREBUHXCJVSPLN]:/u.test(data);
    const adminCommand =
      typeof message?.text === 'string' &&
      /^\/admin_(?:support|appeals|reports)(?:\s|$)/u.test(message.text);
    const replyAuthor = m7Record(m7Record(message?.reply_to_message)?.from);
    const botReply = replyAuthor?.is_bot === true && replyAuthor.id === Number(this.botId);
    if (!adminCallback && !adminCommand && !botReply) return 'unhandled';
    let context: ReturnType<typeof requirePrivateM7Actor>;
    let actor: Actor;
    try {
      context = requirePrivateM7Actor(update, adminCallback ? 'callback' : 'message');
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      actor = { kind: 'admin', userId: session.actor.userId };
    } catch (error) {
      if (expected(error))
        return botReply && !adminCallback && !adminCommand ? 'unhandled' : 'notice';
      throw unavailable();
    }
    try {
      for (const handler of this.handlers) {
        const result = await handler.handle(update);
        if (result !== 'unhandled') return result;
      }
      return 'unhandled';
    } catch (error) {
      if (!expected(error)) throw unavailable();
      return this.reject(context, actor, error);
    }
  }
  private async reject(
    context: ReturnType<typeof requirePrivateM7Actor>,
    actor: Actor,
    error: ApplicationError,
  ): Promise<'notice'> {
    try {
      let session: Awaited<ReturnType<typeof requireTelegramAdminSession>>;
      try {
        session = await requireTelegramAdminSession(
          this.sessions,
          context.telegramUserId,
          this.now,
          actor,
        );
      } catch (failure) {
        if (expected(failure)) return 'notice';
        throw failure;
      }
      const text = this.renderer.render(session.locale, presentM7Error(error));
      if (text.length < 1 || text.length > 3500) throw unavailable();
      const reference = createHmac('sha256', this.key)
        .update(
          JSON.stringify([
            'telegram-admin-rejection-v1',
            this.botId,
            actor.userId,
            context.updateId,
          ]),
        )
        .digest()
        .toString('base64url');
      const claimKey = `telegram-admin-rejection:pending:${reference}`;
      const receiptKey = `telegram-admin-rejection:delivered:${reference}`;
      if ((await this.tokens.get(receiptKey)) === 'delivered') return 'notice';
      if (!(await this.tokens.putIfAbsent(claimKey, 'pending', 30))) {
        if ((await this.tokens.get(receiptKey)) === 'delivered') return 'notice';
        throw unavailable();
      }
      try {
        await requireTelegramAdminSession(this.sessions, context.telegramUserId, this.now, actor);
      } catch (failure) {
        if (expected(failure)) return 'notice';
        throw failure;
      }
      await this.delivery.text({
        recipient: context.telegramUserId,
        text,
        disableLinkPreviews: true,
      });
      await this.tokens.putIfAbsent(receiptKey, 'delivered', 86400);
      if ((await this.tokens.get(receiptKey)) !== 'delivered') throw unavailable();
      return 'notice';
    } catch {
      throw unavailable();
    }
  }
}
