import type {
  ChatMessageResult,
  SendPredefinedAnswerCommand,
  SendPredefinedQuestionCommand,
  SendTextMessageCommand,
} from '@nakh/contracts';
import { ApplicationError, type IdGenerator, normalizeChatText } from '@nakh/domain';

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

export type SendTextChatMessageWrite = Readonly<{
  command: SendTextMessageCommand;
  chatSessionId: string;
  normalizedText: string;
  messageId: string;
  eventId: string;
}>;

export interface TextChatMessageStore {
  sendText(write: SendTextChatMessageWrite): Promise<ChatMessageResult>;
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

export class SendTextMessageHandler {
  public constructor(
    private readonly store: TextChatMessageStore,
    private readonly references: ChatActionReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: SendTextMessageCommand): Promise<ChatMessageResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const normalizedText = normalizeChatText(command.data.text);
    const chatSessionId = await this.references.resolveChatAction(
      command.data.chatActionToken,
      command.actor.userId,
    );
    if (chatSessionId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    return this.store.sendText({
      command,
      chatSessionId,
      normalizedText,
      messageId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}
