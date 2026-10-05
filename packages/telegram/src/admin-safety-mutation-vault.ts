import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type {
  ConfirmedSupportCommands,
  ConfirmedAppealCommands,
  ConfirmedReviewAssignments,
  ConfirmedReviewDecisions,
  ConfirmedAccountActions,
  ConfirmedPhotoActions,
  ConfirmedInternalBlocks,
  ConfirmedEvidenceReveals,
  OpaqueTokenStore,
} from '@nakh/application';
import {
  ApplicationError,
  normalizeAdminReason,
  normalizeSupportText,
  normalizeReviewNote,
  type Actor,
} from '@nakh/domain';
export type TelegramConfirmedSupportMutation = Readonly<{
  binding: string;
  command: Parameters<ConfirmedSupportCommands['execute']>[0];
}>;
export type TelegramConfirmedAppealReview = Readonly<{
  binding: string;
  command: Extract<
    Parameters<ConfirmedAppealCommands['execute']>[0],
    { commandType: 'moderation.review-appeal' }
  >;
}>;
export type TelegramConfirmedAppealUnban = Readonly<{
  binding: string;
  command: Extract<
    Parameters<ConfirmedAppealCommands['execute']>[0],
    { commandType: 'moderation.unban-appeal' }
  >;
}>;
export type TelegramConfirmedReportAssignment = Readonly<{
  binding: string;
  command: Parameters<ConfirmedReviewAssignments['execute']>[0];
}>;
export type TelegramConfirmedReportDecision = Readonly<{
  binding: string;
  command: Parameters<ConfirmedReviewDecisions['execute']>[0];
}>;
export type TelegramConfirmedReportAccountAction = Readonly<{
  binding: string;
  command: Parameters<ConfirmedAccountActions['execute']>[0];
}>;
export type TelegramConfirmedReportPhotoAction = Readonly<{
  binding: string;
  command: Parameters<ConfirmedPhotoActions['execute']>[0];
}>;
export type TelegramConfirmedReportEvidenceRead = Readonly<{
  binding: string;
  command: Parameters<ConfirmedEvidenceReveals['execute']>[0];
}>;
export type TelegramConfirmedReportInternalBlock = Readonly<{
  binding: string;
  command: Parameters<ConfirmedInternalBlocks['execute']>[0];
}>;
type Purpose =
  | 'support'
  | 'appeal-review'
  | 'appeal-unban'
  | 'report-assignment'
  | 'report-decision'
  | 'report-account'
  | 'report-photo'
  | 'report-evidence'
  | 'report-block';
type Selection<P extends Purpose> = P extends 'support'
  ? TelegramConfirmedSupportMutation
  : P extends 'appeal-review'
    ? TelegramConfirmedAppealReview
    : P extends 'appeal-unban'
      ? TelegramConfirmedAppealUnban
      : P extends 'report-assignment'
        ? TelegramConfirmedReportAssignment
        : P extends 'report-decision'
          ? TelegramConfirmedReportDecision
          : P extends 'report-account'
            ? TelegramConfirmedReportAccountAction
            : P extends 'report-photo'
              ? TelegramConfirmedReportPhotoAction
              : P extends 'report-block'
                ? TelegramConfirmedReportInternalBlock
                : TelegramConfirmedReportEvidenceRead;
type Mutation =
  | TelegramConfirmedSupportMutation
  | TelegramConfirmedAppealReview
  | TelegramConfirmedAppealUnban
  | TelegramConfirmedReportAssignment
  | TelegramConfirmedReportDecision
  | TelegramConfirmedReportAccountAction
  | TelegramConfirmedReportPhotoAction
  | TelegramConfirmedReportEvidenceRead
  | TelegramConfirmedReportInternalBlock;
import { m7Record } from './m7-private-update.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REFERENCE = /^[A-Za-z0-9_-]{22}$/u;
function invalid(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
}
function unavailable(): ApplicationError {
  return new ApplicationError('internal_error', 'error.m7.internal', 500);
}
function keys(row: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(row).every((key) => allowed.includes(key));
}
function string(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}
function utcTimestamp(value: string): boolean {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}
function binding(selected: Mutation, includeConfirmation: boolean): string {
  const command = selected.command;
  return JSON.stringify([
    selected.binding,
    command.commandId,
    command.commandType,
    command.schemaVersion,
    command.actor.kind,
    command.actor.userId,
    command.requestId,
    command.idempotencyKey,
    command.occurredAt,
    command.locale,
    command.channelContext?.channel,
    command.channelContext?.channelIdentityId,
    includeConfirmation ? command.data.adminActionToken : undefined,
    includeConfirmation ? command.data.confirmationToken : undefined,
    command.commandType === 'moderation.reveal-evidence'
      ? command.data.evidenceId
      : command.data.expectedTargetVersion,
    normalizeAdminReason(command.data.reason),
    command.commandType === 'support.reply-thread'
      ? normalizeSupportText(command.data.text)
      : command.commandType === 'moderation.review-appeal' ||
          command.commandType === 'moderation.decide-review'
        ? [command.data.decision, normalizeReviewNote(command.data.note)]
        : command.commandType === 'moderation.unban-appeal'
          ? command.data.expectedAccountVersion
          : command.commandType === 'moderation.apply-account-action' ||
              command.commandType === 'moderation.apply-photo-action' ||
              command.commandType === 'moderation.change-internal-block'
            ? command.data.action
            : command.commandType === 'moderation.assign-review'
              ? command.data.assigneeAdminId
              : undefined,
  ]);
}
function readCommand(value: unknown, actor: Actor, purpose: Purpose): value is Mutation {
  const selected = m7Record(value),
    command = m7Record(selected?.command),
    data = m7Record(command?.data),
    owner = m7Record(command?.actor);
  if (
    selected === undefined ||
    command === undefined ||
    data === undefined ||
    owner === undefined ||
    !keys(selected, ['binding', 'command']) ||
    typeof selected.binding !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(selected.binding) ||
    !keys(command, [
      'commandId',
      'commandType',
      'schemaVersion',
      'actor',
      'requestId',
      'idempotencyKey',
      'occurredAt',
      'locale',
      'channelContext',
      'data',
    ]) ||
    !(
      purpose === 'support'
        ? ['support.reply-thread', 'support.close-thread']
        : purpose === 'appeal-review'
          ? ['moderation.review-appeal']
          : purpose === 'appeal-unban'
            ? ['moderation.unban-appeal']
            : purpose === 'report-assignment'
              ? ['moderation.assign-review']
              : purpose === 'report-decision'
                ? ['moderation.decide-review']
                : purpose === 'report-account'
                  ? ['moderation.apply-account-action']
                  : purpose === 'report-photo'
                    ? ['moderation.apply-photo-action']
                    : purpose === 'report-block'
                      ? ['moderation.change-internal-block']
                      : ['moderation.reveal-evidence']
    ).includes(String(command.commandType)) ||
    command.schemaVersion !== 1 ||
    !keys(owner, ['kind', 'userId']) ||
    owner.kind !== 'admin' ||
    owner.userId !== actor.userId ||
    !string(command.commandId, 36, 36) ||
    !UUID.test(command.commandId) ||
    !string(command.requestId, 36, 36) ||
    !UUID.test(command.requestId) ||
    !string(command.idempotencyKey, 8, 128) ||
    !string(command.occurredAt, 20, 40) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(command.occurredAt) ||
    !utcTimestamp(command.occurredAt) ||
    !string(command.locale, 2, 16) ||
    !/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(command.locale) ||
    !keys(
      data,
      command.commandType === 'support.reply-thread'
        ? ['adminActionToken', 'confirmationToken', 'reason', 'expectedTargetVersion', 'text']
        : command.commandType === 'moderation.review-appeal' ||
            command.commandType === 'moderation.decide-review'
          ? [
              'adminActionToken',
              'confirmationToken',
              'reason',
              'expectedTargetVersion',
              'decision',
              'note',
            ]
          : command.commandType === 'moderation.unban-appeal'
            ? [
                'adminActionToken',
                'confirmationToken',
                'reason',
                'expectedTargetVersion',
                'expectedAccountVersion',
              ]
            : command.commandType === 'moderation.assign-review'
              ? [
                  'adminActionToken',
                  'confirmationToken',
                  'reason',
                  'expectedTargetVersion',
                  'assigneeAdminId',
                ]
              : command.commandType === 'moderation.apply-account-action' ||
                  command.commandType === 'moderation.apply-photo-action' ||
                  command.commandType === 'moderation.change-internal-block'
                ? [
                    'adminActionToken',
                    'confirmationToken',
                    'reason',
                    'expectedTargetVersion',
                    'action',
                  ]
                : command.commandType === 'moderation.reveal-evidence'
                  ? ['adminActionToken', 'confirmationToken', 'reason', 'evidenceId']
                  : ['adminActionToken', 'confirmationToken', 'reason', 'expectedTargetVersion'],
    ) ||
    !string(data.adminActionToken, 1, 64) ||
    !/^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(data.adminActionToken) ||
    !string(data.confirmationToken, 1, 64) ||
    !/^v1\.cf\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(data.confirmationToken) ||
    (command.commandType === 'moderation.reveal-evidence'
      ? typeof data.evidenceId !== 'string' || !UUID.test(data.evidenceId)
      : typeof data.expectedTargetVersion !== 'number' ||
        !Number.isSafeInteger(data.expectedTargetVersion) ||
        data.expectedTargetVersion < 1) ||
    !string(data.reason, 1, 4096)
  )
    return false;
  try {
    if (
      command.commandType === 'moderation.change-internal-block' &&
      !['create', 'remove'].includes(String(data.action))
    )
      return false;
    if (normalizeAdminReason(data.reason) !== data.reason) return false;
    if (
      command.commandType === 'moderation.apply-photo-action' &&
      !['hide_photo', 'restore_photo', 'delete_photo'].includes(String(data.action))
    )
      return false;
    if (
      command.commandType === 'moderation.apply-account-action' &&
      !['restrict_user', 'unrestrict_user', 'ban_user', 'unban_user'].includes(String(data.action))
    )
      return false;
    if (
      command.commandType === 'moderation.assign-review' &&
      (typeof data.assigneeAdminId !== 'string' || !UUID.test(data.assigneeAdminId))
    )
      return false;
    if (
      command.commandType === 'moderation.unban-appeal' &&
      (typeof data.expectedAccountVersion !== 'number' ||
        !Number.isSafeInteger(data.expectedAccountVersion) ||
        data.expectedAccountVersion < 1)
    )
      return false;
    if (command.commandType === 'support.reply-thread') {
      if (typeof data.text !== 'string' || normalizeSupportText(data.text) !== data.text)
        return false;
    }
    if (
      command.commandType === 'moderation.review-appeal' ||
      command.commandType === 'moderation.decide-review'
    ) {
      if (
        !(
          command.commandType === 'moderation.review-appeal'
            ? ['accepted', 'rejected']
            : ['dismissed', 'actioned']
        ).includes(String(data.decision)) ||
        (data.note !== undefined &&
          (typeof data.note !== 'string' || normalizeReviewNote(data.note) !== data.note))
      )
        return false;
    }
  } catch {
    return false;
  }
  if (command.channelContext !== undefined) {
    const context = m7Record(command.channelContext);
    if (
      context === undefined ||
      !keys(context, ['channel', 'channelIdentityId']) ||
      typeof context.channel !== 'string' ||
      !['telegram', 'web', 'mobile', 'internal'].includes(context.channel) ||
      (context.channelIdentityId !== undefined && !string(context.channelIdentityId, 1, 128))
    )
      return false;
  }
  return true;
}

/** Encrypted five-minute native mutation drafts. UI decisions never grant authority or undo effects. */
export class TelegramAdminSafetyMutationVault<P extends Purpose> {
  private readonly encryptionKey: Uint8Array;
  private readonly referenceKey: Uint8Array;
  public constructor(
    private readonly purpose: P,
    private readonly store: OpaqueTokenStore,
    encryptionKey: Uint8Array,
    referenceKey: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (
      ![
        'support',
        'appeal-review',
        'appeal-unban',
        'report-assignment',
        'report-decision',
        'report-account',
        'report-photo',
        'report-evidence',
        'report-block',
      ].includes(purpose) ||
      encryptionKey.byteLength !== 32 ||
      referenceKey.byteLength < 32 ||
      Buffer.from(encryptionKey).equals(Buffer.from(referenceKey))
    )
      throw new Error('Admin support mutation vault configuration invalid.');
    this.encryptionKey = Uint8Array.from(encryptionKey);
    this.referenceKey = Uint8Array.from(referenceKey);
  }
  private aad(actor: Actor, reference: string): Buffer {
    return Buffer.from(
      JSON.stringify([`telegram-admin-${this.purpose}-mutation-v1`, actor.userId, reference]),
    );
  }
  public async issue(actor: Actor, selected: Selection<P>, operationId: string): Promise<string> {
    return this.allocate(actor, selected, operationId, true);
  }
  /** Only for freshly native-prepared reads. Retains the winning confirmation token when
   * concurrent preparations issue different valid tokens for the same exact draft. */
  public async retainPrepared(
    actor: Actor,
    selected: Selection<P>,
    operationId: string,
  ): Promise<string> {
    return this.allocate(actor, selected, operationId, false);
  }
  private async allocate(
    actor: Actor,
    selected: Selection<P>,
    operationId: string,
    includeConfirmation: boolean,
  ): Promise<string> {
    if (
      actor.kind !== 'admin' ||
      !UUID.test(actor.userId) ||
      !/^[A-Za-z0-9:_-]{1,128}$/u.test(operationId) ||
      !readCommand(selected, actor, this.purpose)
    )
      throw invalid();
    const reference = createHmac('sha256', this.referenceKey)
      .update(this.aad(actor, operationId))
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    try {
      const expiresAt = this.now() + 300000;
      if (!Number.isSafeInteger(expiresAt)) throw unavailable();
      const plaintext = Buffer.from(JSON.stringify({ selected, expiresAt }));
      if (plaintext.byteLength > 16384) throw invalid();
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
      cipher.setAAD(this.aad(actor, reference));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await this.store.putIfAbsent(
        `telegram-admin-${this.purpose}-mutation:${reference}`,
        JSON.stringify({
          version: 1,
          nonce: nonce.toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        }),
        300,
      );
      const stored = await this.resolve(actor, reference);
      if (stored === undefined) throw unavailable();
      if (binding(stored, includeConfirmation) !== binding(selected, includeConfirmation))
        throw new ApplicationError('idempotency_conflict', 'error.m7.stale_action', 409);
      return reference;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    }
  }
  private async read(actor: Actor, reference: string): Promise<Selection<P> | undefined> {
    if (actor.kind !== 'admin' || !UUID.test(actor.userId) || !REFERENCE.test(reference))
      return undefined;
    let encoded: string | undefined;
    try {
      encoded = await this.store.get(`telegram-admin-${this.purpose}-mutation:${reference}`);
    } catch {
      throw unavailable();
    }
    if (encoded === undefined || encoded.length > 32768) return undefined;
    try {
      const envelope = m7Record(JSON.parse(encoded) as unknown);
      if (
        envelope === undefined ||
        !keys(envelope, ['version', 'nonce', 'ciphertext', 'tag']) ||
        envelope.version !== 1 ||
        !string(envelope.nonce, 16, 16) ||
        !string(envelope.tag, 22, 22) ||
        !string(envelope.ciphertext, 1, 22000) ||
        [envelope.nonce, envelope.tag, envelope.ciphertext].some(
          (value) => !/^[A-Za-z0-9_-]+$/u.test(value),
        )
      )
        return undefined;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(envelope.nonce, 'base64url'),
      );
      decipher.setAAD(this.aad(actor, reference));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const state = m7Record(JSON.parse(plaintext.toString('utf8')) as unknown);
      const now = this.now();
      if (
        state === undefined ||
        !keys(state, ['selected', 'expiresAt']) ||
        typeof state.expiresAt !== 'number' ||
        !Number.isSafeInteger(state.expiresAt) ||
        !Number.isFinite(now) ||
        state.expiresAt <= now ||
        !readCommand(state.selected, actor, this.purpose)
      )
        return undefined;
      return state.selected as Selection<P>;
    } catch {
      return undefined;
    }
  }
  public async resolve(actor: Actor, reference: string): Promise<Selection<P> | undefined> {
    return this.read(actor, reference);
  }
  /** A single first-write-wins UI decision: concurrent Confirm/Cancel cannot both win. Native
   * command execution still rechecks permission/version and owns durable replay and auditing. */
  public async decide(
    actor: Actor,
    reference: string,
    decision: 'confirm' | 'cancel',
  ): Promise<boolean> {
    if ((await this.read(actor, reference)) === undefined) return false;
    try {
      const key = `telegram-admin-${this.purpose}-mutation-decision:${reference}`;
      await this.store.putIfAbsent(key, decision, 300);
      return (await this.store.get(key)) === decision;
    } catch {
      throw unavailable();
    }
  }
  public async pending(actor: Actor, reference: string): Promise<Selection<P> | undefined> {
    const selected = await this.read(actor, reference);
    if (selected === undefined) return undefined;
    try {
      return (await this.store.get(
        `telegram-admin-${this.purpose}-mutation-decision:${reference}`,
      )) === undefined
        ? selected
        : undefined;
    } catch {
      throw unavailable();
    }
  }
  /** Content readers resolve only after the explicit Confirm decision has won. */
  public async confirmed(actor: Actor, reference: string): Promise<Selection<P> | undefined> {
    const selected = await this.read(actor, reference);
    if (selected === undefined) return undefined;
    try {
      return (await this.store.get(
        `telegram-admin-${this.purpose}-mutation-decision:${reference}`,
      )) === 'confirm'
        ? selected
        : undefined;
    } catch {
      throw unavailable();
    }
  }
}
