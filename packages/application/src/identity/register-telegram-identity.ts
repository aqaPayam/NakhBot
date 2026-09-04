import type {
  RegisterTelegramIdentityCommand,
  RegisterTelegramIdentityResult,
} from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

import type { IdentityStore } from './store.js';

export interface RegisterTelegramIdentityUseCase {
  execute(command: RegisterTelegramIdentityCommand): Promise<RegisterTelegramIdentityResult>;
}

export class RegisterTelegramIdentityHandler implements RegisterTelegramIdentityUseCase {
  public constructor(
    private readonly store: IdentityStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly guestPreviewLimit = 10,
    private readonly defaultLocale = 'en',
  ) {}

  public async execute(
    command: RegisterTelegramIdentityCommand,
  ): Promise<RegisterTelegramIdentityResult> {
    if (
      command.actor.kind !== 'system' ||
      command.channelContext?.channel !== 'telegram' ||
      command.channelContext.channelIdentityId !== command.data.telegramUserId
    ) {
      throw new ApplicationError('unauthorized', 'error.identity.telegram_context_invalid', 401);
    }

    return this.store.registerTelegramIdentity({
      command,
      userId: this.ids.uuid(),
      accountHistoryId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      registrationEventId: this.ids.uuid(),
      startRouteEventId: this.ids.uuid(),
      processedAt: this.clock.now(),
      guestPreviewLimit: this.guestPreviewLimit,
      defaultLocale: this.defaultLocale,
    });
  }
}
