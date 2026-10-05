import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminReportInternalBlocks } from './admin-report-internal-blocks.js';
import type { TelegramAdminReportQueueState } from './admin-report-queue-state.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { M7TextRenderer } from './m7-presentation.js';
const CHOICES = [
  ['C', 'create'],
  ['R', 'remove'],
] as const;
/** Owns only Report block reason replies; native commands own pair authority and effects. */
export class TelegramAdminReportBlockPicker {
  public constructor(
    private readonly botId: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly state: TelegramAdminReportQueueState,
    private readonly actions: Pick<
      TelegramAdminReportInternalBlocks,
      'available' | 'check' | 'prepare'
    >,
    private readonly delivery: Pick<TelegramAdminTextDelivery, 'queueMenu' | 'reasonPrompt'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Report block bot identity invalid.');
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = m7Record(update),
      message = m7Record(root?.message),
      data = m7Record(root?.callback_query)?.data;
    const callback = typeof data === 'string' && /^m7b[CR]:/u.test(data);
    const replied = m7Record(message?.reply_to_message);
    if (
      !callback &&
      (replied === undefined ||
        m7Record(message?.chat)?.type !== 'private' ||
        m7Record(message?.from)?.is_bot !== false)
    )
      return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, callback ? 'callback' : 'message');
      if (!callback && (await this.sessions.current(context.telegramUserId)) === undefined)
        return 'unhandled';
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      if (callback) {
        const match = /^m7b([CR]):([A-Za-z0-9_-]{22})$/u.exec(data);
        if (match === null)
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const reference = match[2]!,
          action = CHOICES.find(([code]) => code === match[1])![1];
        const selected = await this.state.choice(session.actor, reference);
        if (selected === undefined)
          throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
        await this.actions.check(context.telegramUserId, selected, action);
        await requireTelegramAdminSession(
          this.sessions,
          context.telegramUserId,
          this.now,
          session.actor,
        );
        if ((await this.state.choice(session.actor, reference)) === undefined)
          throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
        const messageId = await this.delivery.reasonPrompt({
          recipient: context.telegramUserId,
          text: this.renderer.render(session.locale, {
            key: 'admin.report.block_prompt',
            variables: {},
          }),
          disableLinkPreviews: true,
        });
        await this.state.bindBlockPrompt(session.actor, messageId, reference, action);
      } else {
        const messageId = replied?.message_id;
        if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1)
          return 'unhandled';
        const prompt = await this.state.blockPrompt(session.actor, messageId);
        if (prompt === undefined) return 'unhandled';
        const author = m7Record(replied?.from);
        if (
          author?.id !== Number(this.botId) ||
          author.is_bot !== true ||
          typeof message?.text !== 'string'
        )
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const selected = await this.state.choice(session.actor, prompt.reference);
        if (selected === undefined)
          throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
        await this.actions.prepare(context.telegramUserId, {
          choice: selected,
          action: prompt.blockAction,
          reason: message.text,
          operationId: `bot:${this.botId}:update:${context.updateId}`,
          occurredAt: context.occurredAt,
        });
      }
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
