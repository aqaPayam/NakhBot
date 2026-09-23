import type {
  ChatCapability,
  GetChatCapabilityQuery,
  OpenChatForMatchCommand,
} from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

export type StoredChatCapability = Omit<ChatCapability, 'chatActionToken'>;

export interface ChatCapabilityStore {
  loadForMatch(userId: string, matchId: string): Promise<StoredChatCapability>;
  loadForSession(userId: string, chatSessionId: string): Promise<StoredChatCapability>;
  markSafetyWarningShown(input: {
    userId: string;
    chatSessionId: string;
    expectedVersion: number;
  }): Promise<StoredChatCapability>;
}

export interface ChatOpenReferences {
  resolveMatchAction(token: string, userId: string): Promise<string | undefined>;
  resolveChatAction(token: string, userId: string): Promise<string | undefined>;
  issueChatAction(userId: string, chatSessionId: string, requestId: string): Promise<string>;
}

export interface ChatSafetyWarningPresenter {
  show(input: {
    presentationId: string;
    userId: string;
    chatSessionId: string;
    locale: string;
    titleKey: 'notification.chat_unlock_safety.title';
    bodyKey: 'notification.chat_unlock_safety.body';
  }): Promise<void>;
}

export class OpenChatForMatchHandler {
  public constructor(
    private readonly store: ChatCapabilityStore,
    private readonly references: ChatOpenReferences,
    private readonly warning: ChatSafetyWarningPresenter,
  ) {}

  public async execute(command: OpenChatForMatchCommand): Promise<ChatCapability> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const matchId = await this.references.resolveMatchAction(
      command.data.matchActionToken,
      command.actor.userId,
    );
    if (matchId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    let capability = await this.store.loadForMatch(command.actor.userId, matchId);
    if (capability.mustShowSafetyWarning) {
      await this.warning.show({
        presentationId: command.commandId,
        userId: command.actor.userId,
        chatSessionId: capability.chatSessionId,
        locale: command.locale,
        titleKey: 'notification.chat_unlock_safety.title',
        bodyKey: 'notification.chat_unlock_safety.body',
      });
      capability = await this.store.markSafetyWarningShown({
        userId: command.actor.userId,
        chatSessionId: capability.chatSessionId,
        expectedVersion: capability.version,
      });
    }
    return {
      ...capability,
      chatActionToken: await this.references.issueChatAction(
        command.actor.userId,
        capability.chatSessionId,
        command.requestId,
      ),
    };
  }
}

export class GetChatCapabilityHandler {
  public constructor(
    private readonly store: ChatCapabilityStore,
    private readonly references: ChatOpenReferences,
  ) {}

  public async execute(query: GetChatCapabilityQuery): Promise<ChatCapability> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const chatSessionId = await this.references.resolveChatAction(
      query.chatActionToken,
      query.actor.userId,
    );
    if (chatSessionId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    const capability = await this.store.loadForSession(query.actor.userId, chatSessionId);
    return {
      ...capability,
      chatActionToken: await this.references.issueChatAction(
        query.actor.userId,
        chatSessionId,
        query.requestId,
      ),
    };
  }
}
