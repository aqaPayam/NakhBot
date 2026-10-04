import { createHmac, randomUUID } from 'node:crypto';
import type {
  ConfirmedPhotoActions,
  PrepareSelectedReportPhotoActionHandler,
  PhotoActionDraft,
} from '@nakh/application';
import { ApplicationError, normalizeAdminReason } from '@nakh/domain';
import type { TelegramAdminSafetyMutationVault } from './admin-safety-mutation-vault.js';
import type { TelegramSelectedReportEvidence } from './admin-report-evidence.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { presentM7AdminOutcome, renderM7Notice, type M7TextRenderer } from './m7-presentation.js';

export type TelegramReportPhotoAction = PhotoActionDraft['data']['action'];
export function isTelegramReportPhotoAction(value: string): value is TelegramReportPhotoAction {
  return ['hide_photo', 'restore_photo', 'delete_photo'].includes(value);
}
export class TelegramAdminReportPhotoActions {
  private readonly key: Uint8Array;
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly actions: Pick<PrepareSelectedReportPhotoActionHandler, 'execute'>,
    private readonly commands: Pick<ConfirmedPhotoActions, 'prepare' | 'execute'>,
    private readonly vault: TelegramAdminSafetyMutationVault<'report-photo'>,
    key: Uint8Array,
    private readonly delivery: Pick<TelegramAdminTextDelivery, 'text' | 'reportPhotoMenu'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (key.byteLength < 32) throw new Error('Admin report photo configuration invalid.');
    this.key = Uint8Array.from(key);
  }
  private digest(value: unknown): Buffer {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['telegram-report-photo-v1', value]))
      .digest();
  }
  public async check(
    telegramUserId: string,
    choice: TelegramSelectedReportEvidence,
    action: TelegramReportPhotoAction,
  ): Promise<void> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      if (
        choice.report.kind !== 'report' ||
        choice.evidence.evidenceType !== 'photo' ||
        !isTelegramReportPhotoAction(action)
      )
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      await this.actions.execute(
        {
          actor: { kind: 'admin', userId: session.actor.userId },
          requestId: randomUUID(),
          adminActionToken: choice.report.queueActionToken,
          reportId: choice.report.targetId,
          expectedReportVersion: choice.report.expectedVersion,
          action,
          evidenceId: choice.evidence.evidenceId,
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
    choice: TelegramSelectedReportEvidence,
    action: TelegramReportPhotoAction,
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
      choice: TelegramSelectedReportEvidence;
      action: TelegramReportPhotoAction;
      reason: string;
      operationId: string;
      occurredAt: string;
    }>,
  ): Promise<string> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      const actor = { kind: 'admin' as const, userId: session.actor.userId },
        reason = normalizeAdminReason(input.reason);
      if (
        input.choice.report.kind !== 'report' ||
        input.choice.evidence.evidenceType !== 'photo' ||
        !isTelegramReportPhotoAction(input.action) ||
        !/^[A-Za-z0-9:_-]{1,128}$/u.test(input.operationId) ||
        !Number.isFinite(Date.parse(input.occurredAt)) ||
        new Date(input.occurredAt).toISOString() !== input.occurredAt
      )
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const bytes = this.digest([actor.userId, input.operationId]).subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 0x50;
      bytes[8] = (bytes[8]! & 63) | 0x80;
      const hex = bytes.toString('hex'),
        commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const target = await this.actions.execute(
        {
          actor,
          requestId: commandId,
          adminActionToken: input.choice.report.queueActionToken,
          reportId: input.choice.report.targetId,
          expectedReportVersion: input.choice.report.expectedVersion,
          action: input.action,
          evidenceId: input.choice.evidence.evidenceId,
        },
        actor,
      );
      const draft: PhotoActionDraft = {
        actor,
        commandId,
        requestId: commandId,
        idempotencyKey: commandId,
        schemaVersion: 1,
        occurredAt: input.occurredAt,
        locale: session.locale,
        commandType: 'moderation.apply-photo-action',
        data: {
          adminActionToken: target.adminActionToken,
          expectedTargetVersion: target.photoVersion,
          action: input.action,
          reason,
        },
      };
      const confirmationToken = await this.commands.prepare(draft, actor);
      const reference = await this.vault.retainPrepared(
        actor,
        {
          binding: this.digest([
            actor.userId,
            input.choice.report.queueActionToken,
            input.choice.report.targetId,
            input.choice.report.expectedVersion,
            input.action,
            input.choice.evidence.evidenceId,
            input.choice.evidence.evidenceType,
            input.choice.evidence.snapshotSchemaVersion,
          ]).toString('base64url'),
          command: { ...draft, data: { ...draft.data, confirmationToken } },
        },
        input.operationId,
      );
      const pending = await this.vault.pending(actor, reference);
      if (pending === undefined)
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, actor);
      if (
        (await this.vault.pending(actor, reference))?.command.commandId !==
        pending.command.commandId
      )
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      const render = (key: string): string =>
        this.renderer.render(session.locale, { key, variables: {} });
      await this.delivery.reportPhotoMenu({
        recipient: telegramUserId,
        text: [
          render(`admin.report.photo.${input.action}`),
          render('admin.report.photo_effect'),
          render('admin.confirm.prompt'),
          pending.command.data.reason,
        ].join('\n'),
        disableLinkPreviews: true,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: render('admin.button.confirm'), callback_data: `m7L:${reference}` },
              { text: render('admin.button.cancel'), callback_data: `m7N:${reference}` },
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
    if (typeof data !== 'string' || !/^m7[LN]:/u.test(data)) return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, 'callback'),
        match = /^m7([LN]):([A-Za-z0-9_-]{22})$/u.exec(data);
      if (match === null)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const reference = match[2]!,
        selected = await this.vault.resolve(session.actor, reference);
      if (selected === undefined)
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      if (
        !(await this.vault.decide(
          session.actor,
          reference,
          match[1] === 'L' ? 'confirm' : 'cancel',
        ))
      )
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
        session.actor,
      );
      const result =
        match[1] === 'L'
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
