import type {
  ChangeLocaleCommand,
  ChangeSettingsResult,
  ChangeVisibilityCommand,
} from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

import type { ChangeSettingsWrite, IdentityStore } from './store.js';

type SettingsCommand = ChangeLocaleCommand | ChangeVisibilityCommand;

export class ChangeSettingsHandler {
  public constructor(
    private readonly store: IdentityStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: SettingsCommand): Promise<ChangeSettingsResult> {
    if (command.actor.kind !== 'user') {
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    }
    const write: ChangeSettingsWrite = {
      command,
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    };
    return this.store.changeSettings(write);
  }
}
