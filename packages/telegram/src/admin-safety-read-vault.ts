import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { OpaqueTokenStore } from '@nakh/application';
import { ApplicationError, normalizeAdminReason, type Actor } from '@nakh/domain';
import type {
  TelegramConfirmedSafetyRead,
  TelegramConfirmedSafetyReads,
} from './admin-safety-content-adapter.js';
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
function binding(selected: TelegramConfirmedSafetyRead): string {
  const command = selected.command;
  return JSON.stringify([
    selected.kind,
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
    command.data.adminActionToken,
    command.data.confirmationToken,
    command.data.expectedTargetVersion,
    normalizeAdminReason(command.data.reason),
  ]);
}
function readCommand(value: unknown, actor: Actor): value is TelegramConfirmedSafetyRead {
  const selected = m7Record(value),
    command = m7Record(selected?.command),
    data = m7Record(command?.data),
    owner = m7Record(command?.actor);
  if (
    selected === undefined ||
    command === undefined ||
    data === undefined ||
    owner === undefined ||
    !keys(selected, ['kind', 'command']) ||
    (selected.kind !== 'support' && selected.kind !== 'appeal') ||
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
    command.commandType !==
      (selected.kind === 'support' ? 'support.reveal-thread' : 'moderation.reveal-appeal') ||
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
    !keys(data, ['adminActionToken', 'confirmationToken', 'reason', 'expectedTargetVersion']) ||
    !string(data.adminActionToken, 1, 64) ||
    !/^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(data.adminActionToken) ||
    !string(data.confirmationToken, 1, 64) ||
    !/^v1\.cf\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(data.confirmationToken) ||
    typeof data.expectedTargetVersion !== 'number' ||
    !Number.isSafeInteger(data.expectedTargetVersion) ||
    data.expectedTargetVersion < 1 ||
    !string(data.reason, 1, 4096)
  )
    return false;
  try {
    normalizeAdminReason(data.reason);
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

/** Redis UI state only: encrypted native read command, five-minute first-write-wins allocation.
 * Callback references contain no identities/text. This never extends native action/confirmation
 * expiry, grants a permission, or consumes a read; native transaction replay remains authoritative. */
export class TelegramAdminSafetyReadVault implements TelegramConfirmedSafetyReads {
  private readonly encryptionKey: Uint8Array;
  private readonly referenceKey: Uint8Array;
  public constructor(
    private readonly store: OpaqueTokenStore,
    encryptionKey: Uint8Array,
    referenceKey: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (
      encryptionKey.byteLength !== 32 ||
      referenceKey.byteLength < 32 ||
      Buffer.from(encryptionKey).equals(Buffer.from(referenceKey))
    )
      throw new Error('Admin read vault configuration invalid.');
    this.encryptionKey = Uint8Array.from(encryptionKey);
    this.referenceKey = Uint8Array.from(referenceKey);
  }
  private aad(actor: Actor, reference: string): Buffer {
    return Buffer.from(JSON.stringify(['telegram-admin-safety-read-v1', actor.userId, reference]));
  }
  public async issue(
    actor: Actor,
    selected: TelegramConfirmedSafetyRead,
    operationId: string,
  ): Promise<string> {
    if (
      actor.kind !== 'admin' ||
      !UUID.test(actor.userId) ||
      !/^[A-Za-z0-9:_-]{1,128}$/u.test(operationId) ||
      !readCommand(selected, actor)
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
      if (plaintext.byteLength > 8192) throw invalid();
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
      cipher.setAAD(this.aad(actor, reference));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await this.store.putIfAbsent(
        `telegram-admin-safety-read:${reference}`,
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
      if (binding(stored) !== binding(selected))
        throw new ApplicationError('idempotency_conflict', 'error.m7.stale_action', 409);
      return reference;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    }
  }
  private async read(
    actor: Actor,
    reference: string,
  ): Promise<TelegramConfirmedSafetyRead | undefined> {
    if (actor.kind !== 'admin' || !UUID.test(actor.userId) || !REFERENCE.test(reference))
      return undefined;
    let encoded: string | undefined;
    try {
      encoded = await this.store.get(`telegram-admin-safety-read:${reference}`);
    } catch {
      throw unavailable();
    }
    if (encoded === undefined || encoded.length > 16384) return undefined;
    try {
      const envelope = m7Record(JSON.parse(encoded) as unknown);
      if (
        envelope === undefined ||
        !keys(envelope, ['version', 'nonce', 'ciphertext', 'tag']) ||
        envelope.version !== 1 ||
        !string(envelope.nonce, 16, 16) ||
        !string(envelope.tag, 22, 22) ||
        !string(envelope.ciphertext, 1, 11000) ||
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
        !readCommand(state.selected, actor)
      )
        return undefined;
      return state.selected;
    } catch {
      return undefined;
    }
  }
  public async resolve(
    actor: Actor,
    reference: string,
  ): Promise<TelegramConfirmedSafetyRead | undefined> {
    const selected = await this.read(actor, reference);
    if (selected === undefined) return undefined;
    try {
      return (await this.store.get(`telegram-admin-safety-read-withdrawn:${reference}`)) ===
        undefined
        ? selected
        : undefined;
    } catch {
      throw unavailable();
    }
  }
  /** Withdraws only owned pending UI state. Repeating cancellation does not extend authorization. */
  public async withdraw(actor: Actor, reference: string): Promise<boolean> {
    if ((await this.read(actor, reference)) === undefined) return false;
    try {
      await this.store.putIfAbsent(`telegram-admin-safety-read-withdrawn:${reference}`, '1', 300);
      return true;
    } catch {
      throw unavailable();
    }
  }
}
