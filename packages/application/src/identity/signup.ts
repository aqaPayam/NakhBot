import type { SaveSignupStepCommand, SignupState, StartSignupCommand } from '@nakh/contracts';
import { ApplicationError, type Actor, type Clock, type IdGenerator } from '@nakh/domain';

export type StartSignupWrite = Readonly<{
  command: StartSignupCommand;
  accountHistoryId: string;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export type SaveSignupStepWrite = Readonly<{
  command: SaveSignupStepCommand;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export interface SignupStore {
  startSignup(write: StartSignupWrite): Promise<SignupState>;
  saveSignupStep(write: SaveSignupStepWrite): Promise<SignupState>;
  getSignupState(userId: string): Promise<SignupState | undefined>;
}

function requireUser(command: StartSignupCommand | SaveSignupStepCommand): void {
  if (command.actor.kind !== 'user')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}

export class StartSignupHandler {
  public constructor(
    private readonly store: SignupStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: StartSignupCommand): Promise<SignupState> {
    requireUser(command);
    return this.store.startSignup({
      command,
      accountHistoryId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}

export class SaveSignupStepHandler {
  public constructor(
    private readonly store: SignupStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: SaveSignupStepCommand): Promise<SignupState> {
    requireUser(command);
    return this.store.saveSignupStep({
      command,
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}

export class GetSignupStateHandler {
  public constructor(private readonly store: SignupStore) {}

  public async execute(actor: Actor): Promise<SignupState | undefined> {
    if (actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.getSignupState(actor.userId);
  }
}
