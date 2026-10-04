import { createHmac } from 'node:crypto';
import type {
  ConfirmedAppealCommands,
  PrepareAppealReviewAccessHandler,
  AppealAdminDraft,
} from '@nakh/application';
import { ApplicationError, normalizeAdminReason, normalizeReviewNote } from '@nakh/domain';
import type { TelegramAdminSafetyMutationVault } from './admin-safety-mutation-vault.js';
import type { TelegramSafetyQueueChoice } from './admin-safety-queue-state.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import { chunkM7EvidenceText } from './admin-evidence-adapter.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { presentM7AdminOutcome, renderM7Notice, type M7TextRenderer } from './m7-presentation.js';

/** Exact selected appeal review only. Accept/Reject never invokes or prepares an unban. */
export class TelegramAdminAppealReviews {
  private readonly key: Uint8Array;
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly actions: Pick<PrepareAppealReviewAccessHandler, 'execute'>,
    private readonly commands: Pick<ConfirmedAppealCommands, 'prepare' | 'execute'>,
    private readonly vault: TelegramAdminSafetyMutationVault<'appeal-review'>,
    key: Uint8Array,
    private readonly delivery: Pick<TelegramAdminTextDelivery, 'text' | 'appealReviewMenu'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (key.byteLength < 32) throw new Error('Admin appeal review configuration invalid.');
    this.key = Uint8Array.from(key);
  }
  private digest(value: unknown): Buffer {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['telegram-admin-appeal-review-mutation-v1', value]))
      .digest();
  }
  public async prepare(
    telegramUserId: string,
    input: Readonly<{
      choice: TelegramSafetyQueueChoice;
      action: 'accepted' | 'rejected';
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
        input.choice.kind !== 'appeal' ||
        !['accepted', 'rejected'].includes(input.action) ||
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
          appealId: input.choice.targetId,
          expectedAppealVersion: input.choice.expectedVersion,
          action: 'review',
        },
        actor,
      );
      if (target.appealVersion !== input.choice.expectedVersion)
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
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
          expectedTargetVersion: target.appealVersion,
          reason,
        },
      };
      const draft: Extract<AppealAdminDraft, { commandType: 'moderation.review-appeal' }> = {
        ...base,
        commandType: 'moderation.review-appeal',
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
          `${render('admin.appeal.note_preview')}\n${pending.command.data.note}`,
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
      await this.delivery.appealReviewMenu({
        recipient: telegramUserId,
        text: [
          render(`admin.appeal.${input.action}`),
          render('admin.appeal.ban_remains'),
          render('admin.confirm.prompt'),
          pending.command.data.reason,
        ].join('\n'),
        disableLinkPreviews: true,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: render('admin.button.confirm'), callback_data: `m7d:${reference}` },
              { text: render('admin.button.cancel'), callback_data: `m7z:${reference}` },
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
    if (typeof data !== 'string' || !/^m7[dz]:/u.test(data)) return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, 'callback');
      const match = /^m7([dz]):([A-Za-z0-9_-]{22})$/u.exec(data);
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
          match[1] === 'd' ? 'confirm' : 'cancel',
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
        match[1] === 'd'
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
