import { createHmac, randomUUID } from 'node:crypto';
import type {
  ConfirmedReviewDecisions,
  PrepareSelectedReportReviewHandler,
  ReviewDecisionDraft,
} from '@nakh/application';
import { ApplicationError, normalizeAdminReason, normalizeReviewNote } from '@nakh/domain';
import type { TelegramAdminSafetyMutationVault } from './admin-safety-mutation-vault.js';
import type { TelegramReportQueueChoice } from './admin-report-queue-state.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import { chunkM7EvidenceText } from './admin-evidence-adapter.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { presentM7AdminOutcome, renderM7Notice, type M7TextRenderer } from './m7-presentation.js';

/** Assigned report-review decision only; account/photo actions remain separate commands. */
export class TelegramAdminReportDecisions {
  private readonly key: Uint8Array;
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly actions: Pick<PrepareSelectedReportReviewHandler, 'execute'>,
    private readonly commands: Pick<ConfirmedReviewDecisions, 'prepare' | 'execute'>,
    private readonly vault: TelegramAdminSafetyMutationVault<'report-decision'>,
    key: Uint8Array,
    private readonly delivery: Pick<TelegramAdminTextDelivery, 'text' | 'reportDecisionMenu'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (key.byteLength < 32) throw new Error('Admin report decision configuration invalid.');
    this.key = Uint8Array.from(key);
  }
  private digest(value: unknown): Buffer {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['telegram-admin-report-decision-mutation-v1', value]))
      .digest();
  }
  public async check(
    telegramUserId: string,
    choice: TelegramReportQueueChoice,
    action: 'dismissed' | 'actioned',
  ): Promise<void> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      if (choice.kind !== 'report' || !['dismissed', 'actioned'].includes(action))
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      await this.actions.execute(
        {
          actor: { kind: 'admin', userId: session.actor.userId },
          requestId: randomUUID(),
          adminActionToken: choice.queueActionToken,
          reportId: choice.targetId,
          expectedReportVersion: choice.expectedVersion,
          action,
        },
        session.actor,
      );
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, session.actor);
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  public async available(
    telegramUserId: string,
    choice: TelegramReportQueueChoice,
    action: 'dismissed' | 'actioned',
  ): Promise<boolean> {
    try {
      await this.check(telegramUserId, choice, action);
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) return false;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  public async prepare(
    telegramUserId: string,
    input: Readonly<{
      choice: TelegramReportQueueChoice;
      action: 'dismissed' | 'actioned';
      reason: string;
      note?: string;
      operationId: string;
      occurredAt: string;
    }>,
  ): Promise<string> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      const actor = { kind: 'admin' as const, userId: session.actor.userId };
      const reason = normalizeAdminReason(input.reason);
      const note = normalizeReviewNote(input.note);
      if (
        input.choice.kind !== 'report' ||
        !['dismissed', 'actioned'].includes(input.action) ||
        !/^[A-Za-z0-9:_-]{1,128}$/u.test(input.operationId) ||
        !Number.isFinite(Date.parse(input.occurredAt)) ||
        new Date(input.occurredAt).toISOString() !== input.occurredAt
      )
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const bytes = this.digest([actor.userId, input.operationId]).subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 0x50;
      bytes[8] = (bytes[8]! & 63) | 0x80;
      const hex = bytes.toString('hex');
      const commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const target = await this.actions.execute(
        {
          actor,
          requestId: commandId,
          adminActionToken: input.choice.queueActionToken,
          reportId: input.choice.targetId,
          expectedReportVersion: input.choice.expectedVersion,
          action: input.action,
        },
        actor,
      );
      const base = {
        actor,
        commandId,
        requestId: commandId,
        idempotencyKey: commandId,
        schemaVersion: 1 as const,
        occurredAt: input.occurredAt,
        locale: session.locale,
        data: {
          adminActionToken: target.adminActionToken,
          expectedTargetVersion: target.reviewVersion,
          reason,
        },
      };
      const draft: ReviewDecisionDraft = {
        ...base,
        commandType: 'moderation.decide-review',
        data: { ...base.data, decision: input.action, ...(note === undefined ? {} : { note }) },
      };
      const confirmationToken = await this.commands.prepare(draft, actor);
      const command = { ...draft, data: { ...draft.data, confirmationToken } };
      const reference = await this.vault.retainPrepared(
        actor,
        {
          binding: this.digest([
            actor.userId,
            input.choice.queueActionToken,
            input.choice.targetId,
            input.choice.expectedVersion,
            input.action,
            target.reviewId,
          ]).toString('base64url'),
          command,
        },
        input.operationId,
      );
      const pending = await this.vault.pending(actor, reference);
      if (pending === undefined)
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      const recheck = async (): Promise<void> => {
        await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, actor);
        if (
          (await this.vault.pending(actor, reference))?.command.commandId !==
          pending.command.commandId
        )
          throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      };
      const render = (key: string): string =>
        this.renderer.render(session.locale, { key, variables: {} });
      if (pending.command.data.note !== undefined) {
        for (const chunk of chunkM7EvidenceText(
          `${render('admin.report.note_preview')}\n${pending.command.data.note}`,
        )) {
          await recheck();
          await this.delivery.text({
            recipient: telegramUserId,
            text: chunk,
            disableLinkPreviews: true,
          });
        }
      }
      await recheck();
      await this.delivery.reportDecisionMenu({
        recipient: telegramUserId,
        text: [
          render(`admin.report.${input.action}`),
          render('admin.report.decision_effect'),
          render('admin.confirm.prompt'),
          pending.command.data.reason,
        ].join('\n'),
        disableLinkPreviews: true,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: render('admin.button.confirm'), callback_data: `m7G:${reference}` },
              { text: render('admin.button.cancel'), callback_data: `m7Z:${reference}` },
            ],
          ],
        },
      });
      return reference;
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const data = m7Record(m7Record(update)?.callback_query)?.data;
    if (typeof data !== 'string' || !/^m7[GZ]:/u.test(data)) return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, 'callback');
      const match = /^m7([GZ]):([A-Za-z0-9_-]{22})$/u.exec(data);
      if (match === null)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const reference = match[2]!;
      const selected = await this.vault.resolve(session.actor, reference);
      if (selected === undefined)
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      if (
        !(await this.vault.decide(
          session.actor,
          reference,
          match[1] === 'G' ? 'confirm' : 'cancel',
        ))
      )
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
        session.actor,
      );
      // A winning Confirm is retryable with the exact saved command; PostgreSQL owns one effect
      // and one audit. Cancel after Confirm never reverses the committed domain mutation.
      const result =
        match[1] === 'G'
          ? (await this.commands.execute(selected.command, session.actor)).result
          : 'succeeded';
      await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
        session.actor,
      );
      await this.delivery.text({
        recipient: context.telegramUserId,
        text: renderM7Notice(this.renderer, session.locale, presentM7AdminOutcome(result)).text,
        disableLinkPreviews: true,
      });
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
