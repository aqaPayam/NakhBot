import type { ConfirmedSupportReveals, ConfirmedAppealReveals } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminReadConfirmationMenus } from './admin-read-confirmation-menu.js';
import type { TelegramAdminSafetyReadVault } from './admin-safety-read-vault.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
export type TelegramSafetyReadDraft =
  | Readonly<{ kind: 'support'; command: Parameters<ConfirmedSupportReveals['prepare']>[0] }>
  | Readonly<{ kind: 'appeal'; command: Parameters<ConfirmedAppealReveals['prepare']>[0] }>;

/** Server-resolved selected target and stable command/operation identities only. Native prepare
 * rechecks permission and binds target/version/reason; this never calls a read or mutation. */
export class TelegramAdminSafetyReadPreparation {
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly support: Pick<ConfirmedSupportReveals, 'prepare'>,
    private readonly appeals: Pick<ConfirmedAppealReveals, 'prepare'>,
    private readonly vault: Pick<TelegramAdminSafetyReadVault, 'retainPrepared'>,
    private readonly menus: Pick<TelegramAdminReadConfirmationMenus, 'present'>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async prepare(
    telegramUserId: string,
    selected: TelegramSafetyReadDraft,
    operationId: string,
  ): Promise<string> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      if (
        selected.command.actor.kind !== 'admin' ||
        selected.command.actor.userId !== session.actor.userId
      )
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      const reference =
        selected.kind === 'support'
          ? await this.vault.retainPrepared(
              session.actor,
              {
                kind: 'support',
                command: {
                  ...selected.command,
                  data: {
                    ...selected.command.data,
                    confirmationToken: await this.support.prepare(selected.command, session.actor),
                  },
                },
              },
              operationId,
            )
          : await this.vault.retainPrepared(
              session.actor,
              {
                kind: 'appeal',
                command: {
                  ...selected.command,
                  data: {
                    ...selected.command.data,
                    confirmationToken: await this.appeals.prepare(selected.command, session.actor),
                  },
                },
              },
              operationId,
            );
      await this.menus.present(telegramUserId, reference);
      return reference;
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
