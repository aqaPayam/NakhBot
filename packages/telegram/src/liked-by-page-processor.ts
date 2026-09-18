import type { GetLockedLikedByPageHandler } from '@nakh/application';

import type { TelegramLikedByPageRequest } from './liked-by-adapter.js';
import type {
  TelegramLockedLikedByPresenter,
  TelegramLockedLikedByScreen,
} from './liked-by-screen.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u;
const TELEGRAM_ID = /^[1-9][0-9]{0,19}$/u;
const CURSOR = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;
const PAGE_SIZE = 5;

function validate(request: TelegramLikedByPageRequest): void {
  if (typeof request !== 'object' || request === null)
    throw new Error('Invalid Telegram Liked By page request.');
  const keys = Object.keys(request).sort().join(',');
  const commandKeys = 'handled,kind,requestId,telegramUserId,updateId,userId';
  const callbackKeys =
    'callbackQueryId,cursor,handled,kind,requestId,telegramUserId,updateId,userId';
  if (
    request.handled !== true ||
    request.kind !== 'page_request' ||
    (keys !== commandKeys && keys !== callbackKeys) ||
    typeof request.userId !== 'string' ||
    !UUID.test(request.userId) ||
    typeof request.requestId !== 'string' ||
    !UUID.test(request.requestId) ||
    typeof request.updateId !== 'string' ||
    !DECIMAL.test(request.updateId) ||
    !Number.isSafeInteger(Number(request.updateId)) ||
    typeof request.telegramUserId !== 'string' ||
    !TELEGRAM_ID.test(request.telegramUserId) ||
    !Number.isSafeInteger(Number(request.telegramUserId)) ||
    (keys === callbackKeys &&
      (typeof request.callbackQueryId !== 'string' ||
        request.callbackQueryId.length < 1 ||
        request.callbackQueryId.length > 128 ||
        typeof request.cursor !== 'string' ||
        !CURSOR.test(request.cursor)))
  )
    throw new Error('Invalid Telegram Liked By page request.');
}

/** Runs after durable claim, so every read and short-lived media grant is fresh for the send. */
export class TelegramLikedByPageProcessor {
  public constructor(
    private readonly page: Pick<GetLockedLikedByPageHandler, 'execute'>,
    private readonly presenter: TelegramLockedLikedByPresenter,
  ) {}

  public async execute(request: TelegramLikedByPageRequest): Promise<TelegramLockedLikedByScreen> {
    validate(request);
    const page = await this.page.execute({
      actor: { kind: 'user', userId: request.userId },
      requestId: request.requestId,
      limit: PAGE_SIZE,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
    return this.presenter.present(page);
  }
}
