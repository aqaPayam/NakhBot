import { randomUUID } from 'node:crypto';
import type {
  GetSafetyQueueActionsHandler,
  GetSupportMetadataHandler,
  GetAppealMetadataHandler,
  PrepareSupportActionHandler,
  PrepareAppealReviewAccessHandler,
} from '@nakh/application';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { TelegramAdminSafetyTargetSelection } from './admin-safety-target-selection.js';
import {
  type TelegramAdminSafetyQueueState,
  validSafetyQueueStatus,
  type TelegramSafetyQueueChoice,
} from './admin-safety-queue-state.js';
import type {
  TelegramAdminQueueDelivery,
  TelegramAdminQueueMenu,
} from './admin-safety-queue-menu.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { M7TextRenderer } from './m7-presentation.js';

type SupportThreadStatus = NonNullable<
  Parameters<GetSupportMetadataHandler['execute']>[0]['status']
>;
type AppealStatus = NonNullable<Parameters<GetAppealMetadataHandler['execute']>[0]['status']>;

/** Register only behind authenticated webhooks. Queue reads are metadata only; a reply to the
 * exact owned prompt prepares an audited read, which still needs its separate Confirm callback. */
export class TelegramAdminSafetyQueueAdapter {
  public constructor(
    private readonly botId: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly queues: Pick<GetSafetyQueueActionsHandler, 'execute'>,
    private readonly support: Pick<GetSupportMetadataHandler, 'execute'>,
    private readonly appeals: Pick<GetAppealMetadataHandler, 'execute'>,
    private readonly supportActions: Pick<PrepareSupportActionHandler, 'execute'>,
    private readonly appealActions: Pick<PrepareAppealReviewAccessHandler, 'execute'>,
    private readonly state: TelegramAdminSafetyQueueState,
    private readonly selections: Pick<TelegramAdminSafetyTargetSelection, 'select'>,
    private readonly delivery: TelegramAdminQueueDelivery &
      Readonly<{
        text: (
          input: Readonly<{ recipient: string; text: string; disableLinkPreviews: true }>,
        ) => Promise<void>;
      }>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Admin queue bot identity invalid.');
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = m7Record(update),
      message = m7Record(root?.message),
      callback = m7Record(root?.callback_query);
    const data = callback?.data;
    const command =
      typeof message?.text === 'string'
        ? /^\/admin_(support|appeals)(?:\s+(\S+))?$/u.exec(message.text)
        : null;
    const callbackHandled =
      typeof data === 'string' && (data.startsWith('m7q:') || data.startsWith('m7p:'));
    const replied = m7Record(message?.reply_to_message);
    if (!callbackHandled && command === null && replied === undefined) return 'unhandled';
    if (
      !callbackHandled &&
      command === null &&
      (m7Record(message?.chat)?.type !== 'private' || m7Record(message?.from)?.is_bot !== false)
    )
      return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, callbackHandled ? 'callback' : 'message');
      // Unrelated replies must remain available to ordinary user flows, including non-admin users.
      if (
        !callbackHandled &&
        command === null &&
        (await this.sessions.current(context.telegramUserId)) === undefined
      )
        return 'unhandled';
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const operationId = `bot:${this.botId}:update:${context.updateId}`;
      if (command !== null) {
        const kind = command[1] === 'support' ? 'support' : 'appeal';
        const status = command[2] ?? (kind === 'support' ? 'open' : 'submitted');
        await this.present(
          context.telegramUserId,
          kind,
          status,
          operationId,
          undefined,
          session.actor,
        );
        return 'notice';
      }
      if (callbackHandled) {
        const match = /^m7([qp]):([A-Za-z0-9_-]{22})$/u.exec(data);
        if (match === null)
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const reference = match[2]!;
        if (match[1] === 'p') {
          const page = await this.state.page(session.actor, reference);
          if (page === undefined)
            throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
          await this.present(
            context.telegramUserId,
            page.kind,
            page.status,
            operationId,
            page.cursor,
            session.actor,
          );
        } else {
          const choice = await this.state.choice(session.actor, reference);
          if (choice === undefined)
            throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
          await this.validateChoice(session, choice);
          await requireTelegramAdminSession(
            this.sessions,
            context.telegramUserId,
            this.now,
            session.actor,
          );
          if ((await this.state.choice(session.actor, reference)) === undefined)
            throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
          const promptId = await this.delivery.reasonPrompt({
            recipient: context.telegramUserId,
            text: this.renderer.render(session.locale, {
              key: 'admin.queue.reason_prompt',
              variables: {},
            }),
            disableLinkPreviews: true,
          });
          await this.state.bindPrompt(session.actor, promptId, reference);
        }
        return 'notice';
      }
      const replyId = replied?.message_id;
      if (typeof replyId !== 'number' || !Number.isSafeInteger(replyId) || replyId < 1)
        return 'unhandled';
      const reference = await this.state.prompt(session.actor, replyId);
      if (reference === undefined) return 'unhandled';
      const author = m7Record(replied?.from);
      if (
        author?.id !== Number(this.botId) ||
        author.is_bot !== true ||
        typeof message?.text !== 'string'
      )
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const choice = await this.state.choice(session.actor, reference);
      if (choice === undefined)
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      await this.selections.select(context.telegramUserId, {
        ...choice,
        reason: message.text,
        operationId,
        occurredAt: context.occurredAt,
      });
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  private async validateChoice(
    session: Awaited<ReturnType<typeof requireTelegramAdminSession>>,
    choice: TelegramSafetyQueueChoice,
  ): Promise<void> {
    const actor = { kind: 'admin' as const, userId: session.actor.userId };
    if (choice.kind === 'support')
      await this.supportActions.execute(
        {
          actor,
          requestId: randomUUID(),
          adminActionToken: choice.queueActionToken,
          threadId: choice.targetId,
          expectedThreadVersion: choice.expectedVersion,
          action: 'reveal',
        },
        actor,
      );
    else
      await this.appealActions.execute(
        {
          actor,
          requestId: randomUUID(),
          adminActionToken: choice.queueActionToken,
          appealId: choice.targetId,
          expectedAppealVersion: choice.expectedVersion,
          action: 'reveal',
        },
        actor,
      );
  }
  private async present(
    telegramUserId: string,
    kind: 'support' | 'appeal',
    status: string,
    operationId: string,
    cursor?: string,
    expectedActor?: Actor,
  ): Promise<void> {
    if (!validSafetyQueueStatus(kind, status))
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const session = await requireTelegramAdminSession(
      this.sessions,
      telegramUserId,
      this.now,
      expectedActor,
    );
    const actor = { kind: 'admin' as const, userId: session.actor.userId };
    const root = await this.queues.execute(
      { actor, requestId: randomUUID(), queue: kind === 'support' ? 'support' : 'appeals' },
      actor,
    );
    const query = {
      actor,
      requestId: randomUUID(),
      adminActionToken: root.adminActionToken,
      limit: 10,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page =
      kind === 'support'
        ? await this.support.execute({ ...query, status: status as SupportThreadStatus }, actor)
        : await this.appeals.execute({ ...query, status: status as AppealStatus }, actor);
    const render = (key: string): string =>
      this.renderer.render(session.locale, { key, variables: {} });
    const rows: (readonly [Readonly<{ text: string; callback_data: string }>])[] = [];
    const pending: string[] = [];
    if (page.items.length > 10)
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    for (const [index, item] of page.items.entries()) {
      const support = 'threadId' in item;
      const reference = await this.state.putChoice(actor, `${operationId}:item:${index}`, {
        kind,
        queueActionToken: root.adminActionToken,
        targetId: support ? item.threadId : item.appealId,
        expectedVersion: item.version,
      });
      pending.push(reference);
      const date = support ? item.createdAt : item.submittedAt;
      if (!Number.isFinite(Date.parse(date)))
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      rows.push([
        {
          text: `${index + 1}. ${render(`admin.queue.status.${item.status}`)} · ${date.slice(0, 16).replace('T', ' ')}`,
          callback_data: `m7q:${reference}`,
        },
      ]);
    }
    if (page.nextCursor !== undefined) {
      const reference = await this.state.putPage(actor, `${operationId}:next`, {
        kind,
        status,
        cursor: page.nextCursor,
      });
      rows.push([{ text: render('admin.queue.next'), callback_data: `m7p:${reference}` }]);
    }
    await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, actor);
    for (const reference of pending)
      if ((await this.state.choice(actor, reference)) === undefined)
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    const text =
      render(kind === 'support' ? 'admin.queue.support_title' : 'admin.queue.appeals_title') +
      '\n' +
      render(rows.length === 0 ? 'admin.queue.empty' : 'admin.queue.choose');
    if (rows.length === 0)
      await this.delivery.text({ recipient: telegramUserId, text, disableLinkPreviews: true });
    else
      await this.delivery.queueMenu({
        recipient: telegramUserId,
        text,
        disableLinkPreviews: true,
        replyMarkup: { inline_keyboard: rows },
      } satisfies TelegramAdminQueueMenu);
  }
}
