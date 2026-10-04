import type { ConfirmedAppealReveals, ConfirmedSupportReveals } from '@nakh/application';
import { ApplicationError, type Actor } from '@nakh/domain';
import {
  chunkM7EvidenceText,
  type TelegramAdminEvidenceDelivery,
} from './admin-evidence-adapter.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import { presentM7AdminOutcome, renderM7Notice, type M7TextRenderer } from './m7-presentation.js';

type SupportCommand = Parameters<ConfirmedSupportReveals['execute']>[0];
type AppealCommand = Parameters<ConfirmedAppealReveals['execute']>[0];
export type TelegramConfirmedSafetyRead =
  | Readonly<{ kind: 'support'; command: SupportCommand }>
  | Readonly<{ kind: 'appeal'; command: AppealCommand }>;
export interface TelegramConfirmedSafetyReads {
  /** Short actor-bound reference to one explicitly confirmed native read, never a mutation. */
  resolve(actor: Actor, reference: string): Promise<TelegramConfirmedSafetyRead | undefined>;
}

/** Content leaves only a fresh successful audited read. No review/unban capability is granted. */
export class TelegramAdminSafetyContentAdapter {
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly commands: TelegramConfirmedSafetyReads,
    private readonly support: Pick<ConfirmedSupportReveals, 'execute'>,
    private readonly appeals: Pick<ConfirmedAppealReveals, 'execute'>,
    private readonly delivery: Pick<TelegramAdminEvidenceDelivery, 'text'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const data = m7Record(m7Record(update)?.callback_query)?.data;
    if (typeof data !== 'string' || !data.startsWith('m7s:')) return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, 'callback');
      const match = /^m7s:([A-Za-z0-9_-]{22,40})$/u.exec(data);
      if (match === null)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const selected = await this.commands.resolve(session.actor, match[1]!);
      if (
        selected === undefined ||
        selected.command.actor.kind !== 'admin' ||
        selected.command.actor.userId !== session.actor.userId
      )
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      const send = async (text: string): Promise<void> => {
        for (const chunk of chunkM7EvidenceText(text)) {
          await requireTelegramAdminSession(
            this.sessions,
            context.telegramUserId,
            this.now,
            session.actor,
          );
          await this.delivery.text({
            recipient: context.telegramUserId,
            text: chunk,
            disableLinkPreviews: true,
          });
        }
      };
      if (selected.kind === 'support') {
        const result = await this.support.execute(selected.command, session.actor);
        await send(
          renderM7Notice(this.renderer, session.locale, presentM7AdminOutcome(result.result)).text,
        );
        if (result.result === 'succeeded' && !result.replayed && result.value !== undefined) {
          if (result.value.messages.length > 50)
            throw new ApplicationError('internal_error', 'error.m7.internal', 500);
          for (const message of result.value.messages) await send(message.text);
        }
      } else {
        const result = await this.appeals.execute(selected.command, session.actor);
        await send(
          renderM7Notice(this.renderer, session.locale, presentM7AdminOutcome(result.result)).text,
        );
        if (result.result === 'succeeded' && !result.replayed && result.value !== undefined) {
          await send(result.value.text);
          if (result.value.note !== undefined) await send(result.value.note);
        }
      }
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
