import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { OpaqueTokenStore } from '@nakh/application';
import {
  ApplicationError,
  REPORT_EVIDENCE_TYPES,
  type Actor,
  type ReportEvidenceType,
} from '@nakh/domain';
import type { TelegramReportAccountAction } from './admin-report-account-actions.js';
import { m7Record } from './m7-private-update.js';

export type TelegramReportQueueChoice = Readonly<{
  kind: 'report';
  queueActionToken: string;
  targetId: string;
  expectedVersion: number;
  status?: string;
}>;
export type TelegramReportQueuePage = Readonly<{
  kind: 'report';
  status: string;
  cursor: string;
}>;
type Prompt = Readonly<{
  reference: string;
  action: 'assign' | 'dismissed' | 'actioned' | TelegramReportAccountAction;
}>;
export type TelegramReportEvidenceChoice = Readonly<{
  reportReference: string;
  evidenceId: string;
  evidenceType: ReportEvidenceType;
  snapshotSchemaVersion: number;
}>;
type State =
  TelegramReportQueueChoice | TelegramReportQueuePage | Prompt | TelegramReportEvidenceChoice;
type Purpose = 'choice' | 'page' | 'prompt' | 'evidence';
const referencePattern = /^[A-Za-z0-9_-]{22}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function validReportQueueStatus(kind: 'report', status: string): boolean {
  return (
    kind === 'report' &&
    ['submitted', 'pending_review', 'dismissed', 'actioned', 'closed'].includes(status)
  );
}
function valid(value: unknown, purpose: Purpose): value is State {
  const row = m7Record(value);
  if (row === undefined) return false;
  if (purpose === 'evidence')
    return (
      Object.keys(row).length === 4 &&
      typeof row.reportReference === 'string' &&
      referencePattern.test(row.reportReference) &&
      typeof row.evidenceId === 'string' &&
      uuidPattern.test(row.evidenceId) &&
      REPORT_EVIDENCE_TYPES.some((type) => type === row.evidenceType) &&
      typeof row.snapshotSchemaVersion === 'number' &&
      Number.isSafeInteger(row.snapshotSchemaVersion) &&
      row.snapshotSchemaVersion > 0
    );
  if (purpose === 'prompt')
    return (
      Object.keys(row).length === 2 &&
      [
        'assign',
        'dismissed',
        'actioned',
        'restrict_user',
        'unrestrict_user',
        'ban_user',
        'unban_user',
      ].includes(String(row.action)) &&
      typeof row.reference === 'string' &&
      referencePattern.test(row.reference)
    );
  if (row.kind !== 'report') return false;
  if (purpose === 'page')
    return (
      Object.keys(row).length === 3 &&
      typeof row.status === 'string' &&
      validReportQueueStatus(row.kind, row.status) &&
      typeof row.cursor === 'string' &&
      /^v1\.m7\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(row.cursor)
    );
  return (
    Object.keys(row).every((key) =>
      ['kind', 'queueActionToken', 'targetId', 'expectedVersion', 'status'].includes(key),
    ) &&
    (row.status === undefined ||
      (typeof row.status === 'string' && validReportQueueStatus(row.kind, row.status))) &&
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
export class TelegramAdminReportQueueState {
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
      JSON.stringify(['telegram-admin-report-queue-v1', actor.userId, purpose, reference]),
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
        `telegram-admin-report-queue:${purpose}:${reference}`,
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
      // metadata selection; native authority is rechecked before prompting and preparing assignment.
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
      encoded = await this.store.get(`telegram-admin-report-queue:${purpose}:${reference}`);
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
    choice: TelegramReportQueueChoice,
  ): Promise<string> {
    return this.put(actor, 'choice', operationId, choice);
  }
  public async choice(
    actor: Actor,
    reference: string,
  ): Promise<TelegramReportQueueChoice | undefined> {
    const state = await this.get(actor, 'choice', reference);
    return state !== undefined && 'targetId' in state ? state : undefined;
  }
  public async putPage(
    actor: Actor,
    operationId: string,
    page: TelegramReportQueuePage,
  ): Promise<string> {
    return this.put(actor, 'page', operationId, page);
  }
  public async putEvidence(
    actor: Actor,
    operationId: string,
    choice: TelegramReportEvidenceChoice,
  ): Promise<string> {
    return this.put(actor, 'evidence', operationId, choice);
  }
  public async evidence(
    actor: Actor,
    reference: string,
  ): Promise<TelegramReportEvidenceChoice | undefined> {
    const state = await this.get(actor, 'evidence', reference);
    return state !== undefined && 'reportReference' in state ? state : undefined;
  }
  public async page(actor: Actor, reference: string): Promise<TelegramReportQueuePage | undefined> {
    const state = await this.get(actor, 'page', reference);
    return state !== undefined && 'cursor' in state ? state : undefined;
  }
  public async bindPrompt(
    actor: Actor,
    messageId: number,
    reference: string,
    action: Prompt['action'] = 'assign',
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
