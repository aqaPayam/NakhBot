import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminReportEvidence } from './admin-report-evidence.js';
import type { TelegramAdminReportPhotoActions } from './admin-report-photo-actions.js';
import type { TelegramAdminReportQueueState } from './admin-report-queue-state.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { M7TextRenderer } from './m7-presentation.js';
const CHOICES = [
  ['V', 'hide_photo'],
  ['S', 'restore_photo'],
  ['P', 'delete_photo'],
] as const;
/** Optional photo capability. Metadata selection remains useful without a delivery revocation provider. */
export class TelegramAdminReportPhotoPicker {
  public constructor(
    private readonly botId: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly selections: Pick<TelegramAdminReportEvidence, 'selection'>,
    private readonly state: TelegramAdminReportQueueState,
    private readonly actions: Pick<
      TelegramAdminReportPhotoActions,
      'available' | 'check' | 'prepare'
    >,
    private readonly delivery: Pick<TelegramAdminTextDelivery, 'queueMenu' | 'reasonPrompt'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Report photo bot identity invalid.');
  }
  public async present(telegramUserId: string, reference: string): Promise<boolean> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      const selected = await this.selections.selection(telegramUserId, reference);
      if (selected.evidence.evidenceType !== 'photo') return false;
      const rows: (readonly [Readonly<{ text: string; callback_data: string }>])[] = [];
      for (const [code, action] of CHOICES)
        if (await this.actions.available(telegramUserId, selected, action))
          rows.push([
            {
              text: this.renderer.render(session.locale, {
                key: `admin.report.photo.${action}`,
                variables: {},
              }),
              callback_data: `m7${code}:${reference}`,
            },
          ]);
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, session.actor);
      if ((await this.state.evidence(session.actor, reference)) === undefined)
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      if (rows.length === 0) return false;
      await this.delivery.queueMenu({
        recipient: telegramUserId,
        disableLinkPreviews: true,
        text: this.renderer.render(session.locale, {
          key: 'admin.report.photo_choose',
          variables: {},
        }),
        replyMarkup: { inline_keyboard: rows },
      });
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = m7Record(update),
      message = m7Record(root?.message),
      data = m7Record(root?.callback_query)?.data;
    const callback = typeof data === 'string' && /^m7[VSP]:/u.test(data);
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
        const match = /^m7([VSP]):([A-Za-z0-9_-]{22})$/u.exec(data);
        if (match === null)
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const reference = match[2]!,
          action = CHOICES.find(([code]) => code === match[1])![1];
        const selected = await this.selections.selection(context.telegramUserId, reference);
        await this.actions.check(context.telegramUserId, selected, action);
        await requireTelegramAdminSession(
          this.sessions,
          context.telegramUserId,
          this.now,
          session.actor,
        );
        if ((await this.state.evidence(session.actor, reference)) === undefined)
          throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
        const messageId = await this.delivery.reasonPrompt({
          recipient: context.telegramUserId,
          text: this.renderer.render(session.locale, {
            key: 'admin.report.photo_prompt',
            variables: {},
          }),
          disableLinkPreviews: true,
        });
        await this.state.bindPhotoPrompt(session.actor, messageId, reference, action);
      } else {
        const messageId = replied?.message_id;
        if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1)
          return 'unhandled';
        const prompt = await this.state.photoPrompt(session.actor, messageId);
        if (prompt === undefined) return 'unhandled';
        const author = m7Record(replied?.from);
        if (
          author?.id !== Number(this.botId) ||
          author.is_bot !== true ||
          typeof message?.text !== 'string'
        )
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const selected = await this.selections.selection(context.telegramUserId, prompt.reference);
        await this.actions.prepare(context.telegramUserId, {
          choice: selected,
          action: prompt.photoAction,
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
