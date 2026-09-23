import type {
  ChatMessageResult,
  SendPredefinedAnswerCommand,
  SendPredefinedQuestionCommand,
} from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

export type SendPredefinedChatMessageCommand =
  SendPredefinedQuestionCommand | SendPredefinedAnswerCommand;

export type SendPredefinedChatMessageWrite = Readonly<{
  command: SendPredefinedChatMessageCommand;
  chatSessionId: string;
  messageId: string;
  eventId: string;
}>;

export interface ChatActionReferenceResolver {
  resolveChatAction(token: string, userId: string): Promise<string | undefined>;
}

export interface PredefinedChatMessageStore {
  sendPredefined(write: SendPredefinedChatMessageWrite): Promise<ChatMessageResult>;
}

abstract class SendPredefinedMessageHandler<TCommand extends SendPredefinedChatMessageCommand> {
  protected constructor(
    private readonly store: PredefinedChatMessageStore,
    private readonly references: ChatActionReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: TCommand): Promise<ChatMessageResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const chatSessionId = await this.references.resolveChatAction(
      command.data.chatActionToken,
      command.actor.userId,
    );
    if (chatSessionId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    return this.store.sendPredefined({
      command,
      chatSessionId,
      messageId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}

export class SendPredefinedQuestionHandler extends SendPredefinedMessageHandler<SendPredefinedQuestionCommand> {
  public constructor(
    store: PredefinedChatMessageStore,
    references: ChatActionReferenceResolver,
    ids: IdGenerator,
  ) {
    super(store, references, ids);
  }
}

export class SendPredefinedAnswerHandler extends SendPredefinedMessageHandler<SendPredefinedAnswerCommand> {
  public constructor(
    store: PredefinedChatMessageStore,
    references: ChatActionReferenceResolver,
    ids: IdGenerator,
  ) {
    super(store, references, ids);
  }
}
