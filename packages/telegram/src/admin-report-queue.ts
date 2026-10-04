import { randomUUID } from 'node:crypto';
import type {
  GetAdminReportQueueActionsHandler,
  GetReportMetadataPageHandler,
} from '@nakh/application';
import { ApplicationError, type Actor } from '@nakh/domain';
import {
  type TelegramAdminReportQueueState,
  validReportQueueStatus,
} from './admin-report-queue-state.js';
import type { TelegramAdminReportAssignments } from './admin-report-assignments.js';
import type { TelegramAdminReportDecisions } from './admin-report-decisions.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { M7TextRenderer } from './m7-presentation.js';
type ReportStatus = NonNullable<Parameters<GetReportMetadataPageHandler['execute']>[0]['status']>;

/** Metadata-only keyset picker; owned prompts prepare assignment or review decisions, never execute them. */
export class TelegramAdminReportQueue {
  public constructor(
    private readonly botId: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly queues: Pick<GetAdminReportQueueActionsHandler, 'execute'>,
    private readonly reports: Pick<GetReportMetadataPageHandler, 'execute'>,
    private readonly state: TelegramAdminReportQueueState,
    private readonly assignments: Pick<TelegramAdminReportAssignments, 'prepare' | 'check'>,
    private readonly delivery: Pick<
      TelegramAdminTextDelivery,
      'text' | 'queueMenu' | 'reasonPrompt'
    >,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
    private readonly decisions?: Pick<
      TelegramAdminReportDecisions,
      'prepare' | 'check' | 'available'
    >,
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Report queue bot identity invalid.');
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = m7Record(update),
      message = m7Record(root?.message),
      data = m7Record(root?.callback_query)?.data;
    const command =
      typeof message?.text === 'string' && /^\/admin_reports(?:\s|$)/u.test(message.text);
    const callback = typeof data === 'string' && /^m7[TOIDA]:/u.test(data);
    const replied = m7Record(message?.reply_to_message);
    if (!command && !callback && replied === undefined) return 'unhandled';
    if (
      !command &&
      !callback &&
      (m7Record(message?.chat)?.type !== 'private' || m7Record(message?.from)?.is_bot !== false)
    )
      return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, callback ? 'callback' : 'message');
      if (
        !command &&
        !callback &&
        (await this.sessions.current(context.telegramUserId)) === undefined
      )
        return 'unhandled';
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const operationId = `bot:${this.botId}:update:${context.updateId}`;
      if (command) {
        const match = /^\/admin_reports(?:\s+(\S+))?$/u.exec(message.text as string);
        if (match === null)
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        await this.present(
          context.telegramUserId,
          match[1] ?? 'pending_review',
          operationId,
          session.actor,
        );
        return 'notice';
      }
      if (callback) {
        const match = /^m7([TOIDA]):([A-Za-z0-9_-]{22})$/u.exec(data);
        if (match === null)
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const reference = match[2]!;
        if (match[1] === 'O') {
          const page = await this.state.page(session.actor, reference);
          if (page === undefined)
            throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
          await this.present(
            context.telegramUserId,
            page.status,
            operationId,
            session.actor,
            page.cursor,
          );
        } else {
          const choice = await this.state.choice(session.actor, reference);
          if (choice === undefined)
            throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
          const action = match[1] === 'D' ? 'dismissed' : match[1] === 'A' ? 'actioned' : 'assign';
          if (action === 'assign') await this.assignments.check(context.telegramUserId, choice);
          else {
            if (this.decisions === undefined)
              throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
            await this.decisions.check(context.telegramUserId, choice, action);
          }
          await requireTelegramAdminSession(
            this.sessions,
            context.telegramUserId,
            this.now,
            session.actor,
          );
          if ((await this.state.choice(session.actor, reference)) === undefined)
            throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
          if (match[1] === 'T' && this.decisions !== undefined) {
            const options = ['I'];
            if (await this.decisions.available(context.telegramUserId, choice, 'dismissed'))
              options.push('D');
            if (await this.decisions.available(context.telegramUserId, choice, 'actioned'))
              options.push('A');
            await requireTelegramAdminSession(
              this.sessions,
              context.telegramUserId,
              this.now,
              session.actor,
            );
            if ((await this.state.choice(session.actor, reference)) === undefined)
              throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
            await this.delivery.queueMenu({
              recipient: context.telegramUserId,
              text: this.renderer.render(session.locale, {
                key: 'admin.report.choose_action',
                variables: {},
              }),
              disableLinkPreviews: true,
              replyMarkup: {
                inline_keyboard: options.map((code) => [
                  {
                    text: this.renderer.render(session.locale, {
                      key:
                        code === 'I'
                          ? 'admin.report.assign'
                          : code === 'D'
                            ? 'admin.report.dismissed'
                            : 'admin.report.actioned',
                      variables: {},
                    }),
                    callback_data: `m7${code}:${reference}`,
                  },
                ]),
              },
            });
            return 'notice';
          }
          const promptId = await this.delivery.reasonPrompt({
            recipient: context.telegramUserId,
            text: this.renderer.render(session.locale, {
              key:
                action === 'assign' ? 'admin.report.assign_prompt' : 'admin.report.decision_prompt',
              variables: {},
            }),
            disableLinkPreviews: true,
          });
          await this.state.bindPrompt(session.actor, promptId, reference, action);
        }
        return 'notice';
      }
      const replyId = replied?.message_id;
      if (typeof replyId !== 'number' || !Number.isSafeInteger(replyId) || replyId < 1)
        return 'unhandled';
      const prompt = await this.state.promptSelection(session.actor, replyId);
      if (prompt === undefined) return 'unhandled';
      const reference = prompt.reference;
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
      if (prompt.action !== 'assign') {
        if (this.decisions === undefined)
          throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
        const newline = message.text.indexOf('\n');
        await this.decisions.prepare(context.telegramUserId, {
          choice,
          action: prompt.action,
          reason: newline < 0 ? message.text : message.text.slice(0, newline),
          ...(newline < 0 ? {} : { note: message.text.slice(newline + 1) }),
          operationId,
          occurredAt: context.occurredAt,
        });
      } else
        await this.assignments.prepare(context.telegramUserId, {
          choice,
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
  private async present(
    telegramUserId: string,
    status: string,
    operationId: string,
    expectedActor: Actor,
    cursor?: string,
  ): Promise<void> {
    if (!validReportQueueStatus('report', status))
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const session = await requireTelegramAdminSession(
        this.sessions,
        telegramUserId,
        this.now,
        expectedActor,
      ),
      actor = { kind: 'admin' as const, userId: session.actor.userId };
    const root = await this.queues.execute({ actor, requestId: randomUUID() }, actor);
    const page = await this.reports.execute(
      {
        actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        status: status as ReportStatus,
        limit: 10,
        ...(cursor === undefined ? {} : { cursor }),
      },
      actor,
    );
    if (page.items.length > 10)
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    const render = (key: string): string =>
      this.renderer.render(session.locale, { key, variables: {} });
    const rows: (readonly [Readonly<{ text: string; callback_data: string }>])[] = [],
      pending: string[] = [];
    for (const [index, item] of page.items.entries()) {
      const reference = await this.state.putChoice(actor, `${operationId}:item:${index}`, {
        kind: 'report',
        queueActionToken: root.metadataActionToken,
        targetId: item.reportId,
        expectedVersion: item.version,
        status: item.status,
      });
      pending.push(reference);
      if (!Number.isFinite(Date.parse(item.submittedAt)))
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      rows.push([
        {
          text: `${index + 1}. ${render(`admin.queue.status.${item.status}`)} · ${item.submittedAt.slice(0, 16).replace('T', ' ')}`,
          callback_data: `m7T:${reference}`,
        },
      ]);
    }
    if (page.nextCursor !== undefined) {
      const reference = await this.state.putPage(actor, `${operationId}:next`, {
        kind: 'report',
        status,
        cursor: page.nextCursor,
      });
      rows.push([{ text: render('admin.queue.next'), callback_data: `m7O:${reference}` }]);
    }
    await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, actor);
    for (const reference of pending)
      if ((await this.state.choice(actor, reference)) === undefined)
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    const text =
      render('admin.report.queue_title') +
      '\n' +
      render(rows.length === 0 ? 'admin.queue.empty' : 'admin.report.queue_choose');
    if (rows.length === 0)
      await this.delivery.text({ recipient: telegramUserId, text, disableLinkPreviews: true });
    else
      await this.delivery.queueMenu({
        recipient: telegramUserId,
        text,
        disableLinkPreviews: true,
        replyMarkup: { inline_keyboard: rows },
      });
  }
}
