import { randomUUID } from 'node:crypto';

import type {
  GetLockedLikedByPageHandler,
  LikedByKeyset,
  LocalizedIntent,
  RateLimiterPort,
  TelegramUserResolver,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type {
  TelegramLockedLikedByPresenter,
  TelegramLockedLikedByScreen,
} from './liked-by-screen.js';

type LikedByPageUseCase = Pick<GetLockedLikedByPageHandler, 'execute'>;

export interface TelegramLikedByReferences {
  resolveCursor(token: string, receiverUserId: string): Promise<LikedByKeyset | undefined>;
  resolveAction(token: string, receiverUserId: string): Promise<string | undefined>;
}

export type TelegramLikedByResult =
  | Readonly<{ handled: false }>
  | Readonly<{
      handled: true;
      kind: 'page';
      updateId: string;
      userId: string;
      telegramUserId: string;
      callbackQueryId?: string;
      screen: TelegramLockedLikedByScreen;
    }>
  | Readonly<{
      handled: true;
      kind: 'notice';
      updateId: string;
      userId: string;
      telegramUserId: string;
      callbackQueryId: string;
      notice: LocalizedIntent;
    }>;

type ParsedUpdate =
  | Readonly<{ kind: 'command'; updateId: string; telegramUserId: string }>
  | Readonly<{
      kind: 'callback';
      updateId: string;
      telegramUserId: string;
      callbackQueryId: string;
      token: string;
    }>;

const PAGE_SIZE = 5;
const TOKEN = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function invalidUpdate(): never {
  throw new ApplicationError('invalid_request', 'error.interaction.unavailable', 400);
}

function parseUpdate(update: unknown): ParsedUpdate | undefined {
  const root = record(update);
  const message = record(root?.message);
  const callback = record(root?.callback_query);
  const data = callback?.data;
  const command = message?.text === '/liked_by';
  if (!command && (typeof data !== 'string' || !data.startsWith('v1.lb.'))) return undefined;
  const selected = command ? message : callback;
  const from = record(selected?.from);
  const chat = record(command ? message?.chat : record(callback?.message)?.chat);
  const updateId = root?.update_id;
  const telegramUserId = from?.id;
  if (
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    typeof telegramUserId !== 'number' ||
    !Number.isSafeInteger(telegramUserId) ||
    telegramUserId <= 0 ||
    chat?.type !== 'private' ||
    chat.id !== telegramUserId
  )
    invalidUpdate();
  const base = { updateId: String(updateId), telegramUserId: String(telegramUserId) };
  if (command) return { ...base, kind: 'command' };
  const callbackQueryId = callback?.id;
  if (
    typeof callbackQueryId !== 'string' ||
    callbackQueryId.length < 1 ||
    callbackQueryId.length > 128 ||
    typeof data !== 'string' ||
    Buffer.byteLength(data, 'utf8') > 64
  )
    invalidUpdate();
  return { ...base, kind: 'callback', callbackQueryId, token: data };
}

/** Transport adapter only. The M3 query remains the sole source of authorization. */
export class TelegramLikedByAdapter {
  public constructor(
    private readonly resolver: TelegramUserResolver,
    private readonly page: LikedByPageUseCase,
    private readonly references: TelegramLikedByReferences,
    private readonly presenter: TelegramLockedLikedByPresenter,
    private readonly limiter: RateLimiterPort,
    private readonly uuid: () => string = randomUUID,
  ) {}

  public async handle(update: unknown): Promise<TelegramLikedByResult> {
    const parsed = parseUpdate(update);
    if (parsed === undefined) return { handled: false };
    const userId = await this.resolver.resolveUserId(parsed.telegramUserId);
    if (userId === undefined)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const rate = await this.limiter.consume({
      scope: 'telegram_liked_by',
      subject: userId,
      limit: 20,
      windowSeconds: 60,
    });
    if (!rate.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429, {
        retryAfterSeconds: String(rate.retryAfterSeconds),
      });
    if (parsed.kind === 'callback') {
      const token = parsed.token;
      const validCursor = TOKEN.test(token)
        ? await this.references.resolveCursor(token, userId)
        : undefined;
      if (validCursor === undefined) {
        const validAction = TOKEN.test(token)
          ? await this.references.resolveAction(token, userId)
          : undefined;
        return {
          handled: true,
          kind: 'notice',
          updateId: parsed.updateId,
          userId,
          telegramUserId: parsed.telegramUserId,
          callbackQueryId: parsed.callbackQueryId,
          notice: {
            key:
              validAction === undefined
                ? 'error.interaction.cursor_invalid'
                : 'error.interaction.unavailable',
            variables: {},
          },
        };
      }
    }
    const query = {
      actor: { kind: 'user' as const, userId },
      requestId: this.uuid(),
      limit: PAGE_SIZE,
      ...(parsed.kind === 'command' ? {} : { cursor: parsed.token }),
    };
    const screen = this.presenter.present(await this.page.execute(query));
    return {
      handled: true,
      kind: 'page',
      updateId: parsed.updateId,
      userId,
      telegramUserId: parsed.telegramUserId,
      ...(parsed.kind === 'command' ? {} : { callbackQueryId: parsed.callbackQueryId }),
      screen,
    };
  }
}
