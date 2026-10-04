import { ApplicationError, normalizeAdminReason } from '@nakh/domain';
import type { TelegramConfirmedSafetyReads } from './admin-safety-content-adapter.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import type { M7TextRenderer } from './m7-presentation.js';

export type TelegramAdminReadConfirmationMenu = Readonly<{
  recipient: string;
  text: string;
  disableLinkPreviews: true;
  replyMarkup: Readonly<{
    inline_keyboard: readonly [
      readonly [
        Readonly<{ text: string; callback_data: string }>,
        Readonly<{ text: string; callback_data: string }>,
      ],
    ];
  }>;
}>;
export interface TelegramAdminReadMenuDelivery {
  menu(input: TelegramAdminReadConfirmationMenu): Promise<void>;
}
/** Called for an already-prepared native read in its selected-target UI context. This presents
 * the operator's own bounded reason and buttons; it never executes a read or fetches user text. */
export class TelegramAdminReadConfirmationMenus {
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly commands: TelegramConfirmedSafetyReads &
      Required<Pick<TelegramConfirmedSafetyReads, 'withdraw'>>,
    private readonly renderer: M7TextRenderer,
    private readonly delivery: TelegramAdminReadMenuDelivery,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async present(telegramUserId: string, reference: string): Promise<void> {
    try {
      if (!/^[A-Za-z0-9_-]{22}$/u.test(reference))
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      const selected = await this.commands.resolve(session.actor, reference);
      if (
        selected === undefined ||
        selected.command.actor.kind !== 'admin' ||
        selected.command.actor.userId !== session.actor.userId
      )
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      const render = (key: string): string =>
        this.renderer.render(session.locale, { key, variables: {} });
      const text = [
        render('admin.confirm.title'),
        render('admin.confirm.prompt'),
        normalizeAdminReason(selected.command.data.reason),
      ].join('\n');
      const confirm = render('admin.button.confirm'),
        cancel = render('admin.button.cancel');
      if (
        text.length < 1 ||
        text.length > 3500 ||
        [confirm, cancel].some((label) => label.trim() === '' || [...label].length > 64)
      )
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, session.actor);
      const current = await this.commands.resolve(session.actor, reference);
      if (
        current === undefined ||
        current.kind !== selected.kind ||
        current.command.commandId !== selected.command.commandId ||
        current.command.actor.kind !== 'admin' ||
        current.command.actor.userId !== session.actor.userId
      )
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      await this.delivery.menu({
        recipient: telegramUserId,
        text,
        disableLinkPreviews: true,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: confirm, callback_data: `m7s:${reference}` },
              { text: cancel, callback_data: `m7c:${reference}` },
            ],
          ],
        },
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
