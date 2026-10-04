import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { OpaqueTokenStore } from '@nakh/application';
import { ApplicationError, type Actor } from '@nakh/domain';
import { m7Record } from './m7-private-update.js';

export type TelegramSafetyQueueChoice = Readonly<{
  kind: 'support' | 'appeal';
  queueActionToken: string;
  targetId: string;
  expectedVersion: number;
  status?: string;
}>;
export type TelegramSafetyQueuePage = Readonly<{
  kind: 'support' | 'appeal';
  status: string;
  cursor: string;
}>;
type Prompt = Readonly<{ reference: string; action: 'read' | 'reply' | 'close' }>;
type State = TelegramSafetyQueueChoice | TelegramSafetyQueuePage | Prompt;
type Purpose = 'choice' | 'page' | 'prompt';
const referencePattern = /^[A-Za-z0-9_-]{22}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function validSafetyQueueStatus(kind: 'support' | 'appeal', status: string): boolean {
  return (
    kind === 'support' ? ['open', 'closed'] : ['submitted', 'in_review', 'accepted', 'rejected']
  ).includes(status);
}
function valid(value: unknown, purpose: Purpose): value is State {
  const row = m7Record(value);
  if (row === undefined) return false;
  if (purpose === 'prompt')
    return (
      Object.keys(row).length === 2 &&
      ['read', 'reply', 'close'].includes(String(row.action)) &&
      typeof row.reference === 'string' &&
      referencePattern.test(row.reference)
    );
  if (row.kind !== 'support' && row.kind !== 'appeal') return false;
  if (purpose === 'page')
    return (
      Object.keys(row).length === 3 &&
      typeof row.status === 'string' &&
      validSafetyQueueStatus(row.kind, row.status) &&
      typeof row.cursor === 'string' &&
      /^v1\.sq\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(row.cursor)
    );
  return (
    Object.keys(row).every((key) =>
      ['kind', 'queueActionToken', 'targetId', 'expectedVersion', 'status'].includes(key),
    ) &&
    (row.status === undefined ||
      (typeof row.status === 'string' && validSafetyQueueStatus(row.kind, row.status))) &&
    typeof row.queueActionToken === 'string' &&
    /^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(row.queueActionToken) &&
    typeof row.targetId === 'string' &&
    uuidPattern.test(row.targetId) &&
    typeof row.expectedVersion === 'number' &&
    Number.isSafeInteger(row.expectedVersion) &&
    row.expectedVersion > 0
  );
}
function unavailable(): ApplicationError {
  return new ApplicationError('internal_error', 'error.m7.internal', 500);
}

/** Five-minute encrypted metadata and reply correlation, never prose or durable authority.
 * Purpose/actor-bound references prevent cross-admin selection and prompt substitution. */
export class TelegramAdminSafetyQueueState {
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
      throw new Error('Admin queue state configuration invalid.');
    this.encryptionKey = Uint8Array.from(encryptionKey);
    this.referenceKey = Uint8Array.from(referenceKey);
  }
  private aad(actor: Actor, purpose: Purpose, reference: string): Buffer {
    return Buffer.from(
      JSON.stringify(['telegram-admin-queue-v1', actor.userId, purpose, reference]),
    );
  }
  private reference(actor: Actor, purpose: Purpose, operationId: string): string {
    return createHmac('sha256', this.referenceKey)
      .update(this.aad(actor, purpose, operationId))
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }
  private async put(
    actor: Actor,
    purpose: Purpose,
    operationId: string,
    state: State,
  ): Promise<string> {
    if (
      actor.kind !== 'admin' ||
      !uuidPattern.test(actor.userId) ||
      !/^[A-Za-z0-9:_-]{1,128}$/u.test(operationId) ||
      !valid(state, purpose)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    try {
      const reference = this.reference(actor, purpose, operationId),
        expiresAt = this.now() + 300000;
      if (!Number.isSafeInteger(expiresAt)) throw unavailable();
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
      cipher.setAAD(this.aad(actor, purpose, reference));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ state, expiresAt })),
        cipher.final(),
      ]);
      await this.store.putIfAbsent(
        `telegram-admin-queue:${purpose}:${reference}`,
        JSON.stringify({
          version: 1,
          nonce: nonce.toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        }),
        300,
      );
      const stored = await this.get(actor, purpose, reference);
      if (stored === undefined) throw unavailable();
      // Concurrent native page reads issue different queue/cursor tokens. Retain the first
      // metadata selection; native authority is rechecked before prompting and preparing reads.
      const binding = (value: State): string =>
        purpose === 'choice' && 'targetId' in value
          ? JSON.stringify([value.kind, value.targetId, value.expectedVersion, value.status])
          : purpose === 'page' && 'cursor' in value
            ? JSON.stringify([value.kind, value.status])
            : JSON.stringify(value);
      if (binding(stored) !== binding(state))
        throw new ApplicationError('idempotency_conflict', 'error.m7.stale_action', 409);
      return reference;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    }
  }
  private async get(actor: Actor, purpose: Purpose, reference: string): Promise<State | undefined> {
    if (
      actor.kind !== 'admin' ||
      !uuidPattern.test(actor.userId) ||
      !referencePattern.test(reference)
    )
      return undefined;
    let encoded: string | undefined;
    try {
      encoded = await this.store.get(`telegram-admin-queue:${purpose}:${reference}`);
    } catch {
      throw unavailable();
    }
    if (encoded === undefined || encoded.length > 4096) return undefined;
    try {
      const row = m7Record(JSON.parse(encoded) as unknown);
      if (
        row === undefined ||
        Object.keys(row).length !== 4 ||
        row.version !== 1 ||
        typeof row.nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{16}$/u.test(row.nonce) ||
        typeof row.tag !== 'string' ||
        !/^[A-Za-z0-9_-]{22}$/u.test(row.tag) ||
        typeof row.ciphertext !== 'string' ||
        !/^[A-Za-z0-9_-]{1,2048}$/u.test(row.ciphertext)
      )
        return undefined;
      const cipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(row.nonce, 'base64url'),
      );
      cipher.setAAD(this.aad(actor, purpose, reference));
      cipher.setAuthTag(Buffer.from(row.tag, 'base64url'));
      const decoded = m7Record(
        JSON.parse(
          Buffer.concat([
            cipher.update(Buffer.from(row.ciphertext, 'base64url')),
            cipher.final(),
          ]).toString('utf8'),
        ) as unknown,
      );
      if (
        decoded === undefined ||
        Object.keys(decoded).length !== 2 ||
        typeof decoded.expiresAt !== 'number' ||
        !Number.isSafeInteger(decoded.expiresAt) ||
        decoded.expiresAt <= this.now() ||
        !Number.isFinite(this.now()) ||
        !valid(decoded.state, purpose)
      )
        return undefined;
      return decoded.state;
    } catch {
      return undefined;
    }
  }
  public async putChoice(
    actor: Actor,
    operationId: string,
    choice: TelegramSafetyQueueChoice,
  ): Promise<string> {
    return this.put(actor, 'choice', operationId, choice);
  }
  public async choice(
    actor: Actor,
    reference: string,
  ): Promise<TelegramSafetyQueueChoice | undefined> {
    const state = await this.get(actor, 'choice', reference);
    return state !== undefined && 'targetId' in state ? state : undefined;
  }
  public async putPage(
    actor: Actor,
    operationId: string,
    page: TelegramSafetyQueuePage,
  ): Promise<string> {
    return this.put(actor, 'page', operationId, page);
  }
  public async page(actor: Actor, reference: string): Promise<TelegramSafetyQueuePage | undefined> {
    const state = await this.get(actor, 'page', reference);
    return state !== undefined && 'cursor' in state ? state : undefined;
  }
  public async bindPrompt(
    actor: Actor,
    messageId: number,
    reference: string,
    action: Prompt['action'] = 'read',
  ): Promise<void> {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw unavailable();
    await this.put(actor, 'prompt', `message:${messageId}`, { reference, action });
  }
  public async prompt(actor: Actor, messageId: number): Promise<string | undefined> {
    return (await this.promptSelection(actor, messageId))?.reference;
  }
  public async promptSelection(actor: Actor, messageId: number): Promise<Prompt | undefined> {
    if (!Number.isSafeInteger(messageId) || messageId < 1) return undefined;
    const state = await this.get(
      actor,
      'prompt',
      this.reference(actor, 'prompt', `message:${messageId}`),
    );
    return state !== undefined && 'reference' in state ? state : undefined;
  }
}
