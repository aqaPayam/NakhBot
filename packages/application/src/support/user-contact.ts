import type { LocalizedIntent } from '../presentation.js';
import type { OpenSupportThreadHandler } from './support.js';
import type { PrepareAppealHandler, SubmitAppealHandler } from './appeal.js';

export type SafetyContactState =
  | Readonly<{ route: 'support' }>
  | Readonly<{ route: 'unavailable' }>
  | Readonly<{ route: 'appeal'; status?: 'submitted' | 'in_review' | 'accepted' | 'rejected' }>;

export interface SafetyContactStateStore {
  get(userId: string): Promise<SafetyContactState>;
}

export type UserSafetyContact = Readonly<{
  userId: string;
  commandId: string;
  kind: 'support' | 'appeal';
  text: string;
}>;

/** Authenticated ingress only. Stores recheck current account authority inside their transaction. */
export class UserSafetyContactHandler {
  public constructor(
    private readonly states: SafetyContactStateStore,
    private readonly support: Pick<OpenSupportThreadHandler, 'execute'>,
    private readonly prepare: Pick<PrepareAppealHandler, 'execute'>,
    private readonly appeals: Pick<SubmitAppealHandler, 'execute'>,
  ) {}

  public async execute(input: UserSafetyContact): Promise<LocalizedIntent> {
    const state = await this.states.get(input.userId);
    const notice = (key: string): LocalizedIntent => ({ key, variables: {} });
    if (state.route === 'unavailable') return notice('error.m7.unavailable');
    if (input.kind === 'support' && state.route === 'appeal') return notice('appeal.prompt');
    if (input.kind === 'appeal' && state.route !== 'appeal') return notice('error.m7.unavailable');
    if (input.text.trim().length === 0) {
      if (state.route === 'support') return notice('support.prompt');
      return notice(state.status === undefined ? 'appeal.prompt' : `appeal.${state.status}`);
    }
    const base = {
      commandId: input.commandId,
      requestId: input.commandId,
      idempotencyKey: input.commandId,
      schemaVersion: 1 as const,
      actor: { kind: 'user' as const, userId: input.userId },
      occurredAt: new Date().toISOString(),
      locale: 'en',
    };
    if (input.kind === 'support') {
      await this.support.execute({
        ...base,
        commandType: 'support.open-thread',
        data: { text: input.text },
      });
      return notice('support.sent');
    }
    const banActionToken = await this.prepare.execute(input.userId, input.commandId);
    await this.appeals.execute({
      ...base,
      commandType: 'moderation.submit-appeal',
      data: { text: input.text, banActionToken },
    });
    return notice('appeal.submitted');
  }
}
