import type {
  ChangeChatMuteCommand,
  ChatMessage,
  ChatMuteResult,
  ChatPage,
  ChatReadResult,
  GetChatPageQuery,
  MarkChatReadCommand,
} from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

import type { ChatActionReferenceResolver } from './predefined-message.js';

export type ChatPageCursor = Readonly<{
  chatSessionId: string;
  beforeSequenceNumber: string;
}>;

export interface ChatPageReferences extends ChatActionReferenceResolver {
  resolveMessageCursor(token: string, userId: string): Promise<ChatPageCursor | undefined>;
  issueMessageCursor(userId: string, cursor: ChatPageCursor, requestId: string): Promise<string>;
}

export type StoredChatPage = Readonly<{
  items: ChatMessage[];
  hasMore: boolean;
}>;

export interface ChatHistoryStore {
  readPage(input: {
    userId: string;
    chatSessionId: string;
    limit: number;
    beforeSequenceNumber?: string;
  }): Promise<StoredChatPage>;
}

export type MarkChatReadWrite = Readonly<{
  command: MarkChatReadCommand;
  chatSessionId: string;
  eventId: string;
}>;

export type ChangeChatMuteWrite = Readonly<{
  command: ChangeChatMuteCommand;
  chatSessionId: string;
  eventId: string;
}>;

export interface ChatParticipantStateStore {
  markRead(write: MarkChatReadWrite): Promise<ChatReadResult>;
  changeMute(write: ChangeChatMuteWrite): Promise<ChatMuteResult>;
}

export class GetChatPageHandler {
  public constructor(
    private readonly store: ChatHistoryStore,
    private readonly references: ChatPageReferences,
  ) {}

  public async execute(query: GetChatPageQuery): Promise<ChatPage> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const chatSessionId = await this.references.resolveChatAction(
      query.chatActionToken,
      query.actor.userId,
    );
    if (chatSessionId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    const cursor =
      query.cursor === undefined
        ? undefined
        : await this.references.resolveMessageCursor(query.cursor, query.actor.userId);
    if (
      query.cursor !== undefined &&
      (cursor === undefined || cursor.chatSessionId !== chatSessionId)
    )
      throw new ApplicationError('invalid_request', 'error.chat.cursor_invalid', 400);
    const page = await this.store.readPage({
      userId: query.actor.userId,
      chatSessionId,
      limit: query.limit,
      ...(cursor === undefined ? {} : { beforeSequenceNumber: cursor.beforeSequenceNumber }),
    });
    if (!page.hasMore) return { items: page.items };
    const last = page.items.at(-1);
    if (last === undefined) throw new ApplicationError('internal_error', 'error.internal', 500);
    return {
      items: page.items,
      nextCursor: await this.references.issueMessageCursor(
        query.actor.userId,
        { chatSessionId, beforeSequenceNumber: last.sequenceNumber },
        query.requestId,
      ),
    };
  }
}

export class MarkChatReadHandler {
  public constructor(
    private readonly store: ChatParticipantStateStore,
    private readonly references: ChatActionReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: MarkChatReadCommand): Promise<ChatReadResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const chatSessionId = await this.references.resolveChatAction(
      command.data.chatActionToken,
      command.actor.userId,
    );
    if (chatSessionId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    return this.store.markRead({ command, chatSessionId, eventId: this.ids.uuid() });
  }
}

export class ChangeChatMuteHandler {
  public constructor(
    private readonly store: ChatParticipantStateStore,
    private readonly references: ChatActionReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: ChangeChatMuteCommand): Promise<ChatMuteResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const chatSessionId = await this.references.resolveChatAction(
      command.data.chatActionToken,
      command.actor.userId,
    );
    if (chatSessionId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    return this.store.changeMute({ command, chatSessionId, eventId: this.ids.uuid() });
  }
}
