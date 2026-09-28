import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  OpenSupportThreadCommand,
  SendSupportMessageCommand,
  SupportThreadResult,
} from '@nakh/contracts';
import { ApplicationError, normalizeSupportText, type IdGenerator } from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import type { OpaqueTokenStore } from '../security/opaque-token.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^(v1\.sp\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
const lifetimeSeconds = 24 * 60 * 60;

type SupportReferenceState = Readonly<{
  version: 1;
  purpose: 'support_action';
  userId: string;
  supportThreadId: string;
  expiresAt: number;
}>;

function validReference(value: unknown): value is SupportReferenceState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(state).length === 5 &&
    state.version === 1 &&
    state.purpose === 'support_action' &&
    typeof state.userId === 'string' &&
    UUID.test(state.userId) &&
    typeof state.supportThreadId === 'string' &&
    UUID.test(state.supportThreadId) &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt)
  );
}

/** Opaque, user-bound support reference; raw thread identifiers never cross the client boundary. */
export class SupportOpaqueReferences {
  private readonly key: Uint8Array;

  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength < 32) throw new Error('Support token key is invalid.');
    this.key = Uint8Array.from(key);
  }

  private signature(unsigned: string): string {
    return createHmac('sha256', this.key)
      .update(unsigned)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  private stableId(userId: string, threadId: string, commandId: string): string {
    if (!UUID.test(userId) || !UUID.test(threadId) || !UUID.test(commandId))
      throw new Error('Support token subject is invalid.');
    return createHmac('sha256', this.key)
      .update(`support-reference-v1\0${userId}\0${threadId}\0${commandId}`)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  public async issue(userId: string, threadId: string, commandId: string): Promise<string> {
    const id = this.stableId(userId, threadId, commandId);
    const state: SupportReferenceState = {
      version: 1,
      purpose: 'support_action',
      userId,
      supportThreadId: threadId,
      expiresAt: this.now() + lifetimeSeconds * 1000,
    };
    const encoded = JSON.stringify(state);
    if (!(await this.store.putIfAbsent(id, encoded, lifetimeSeconds))) {
      const existing = await this.store.get(id);
      if (existing === undefined) throw new Error('Support token allocation failed.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing) as unknown;
      } catch {
        throw new Error('Support token allocation failed.');
      }
      if (
        !validReference(parsed) ||
        parsed.userId !== userId ||
        parsed.supportThreadId !== threadId ||
        parsed.expiresAt <= this.now()
      )
        throw new Error('Support token allocation failed.');
    }
    const unsigned = `v1.sp.${id}`;
    return `${unsigned}.${this.signature(unsigned)}`;
  }

  public async resolve(token: string, userId: string): Promise<string | undefined> {
    const match = TOKEN.exec(token);
    if (match === null || !UUID.test(userId)) return undefined;
    const expected = Buffer.from(this.signature(match[1]!), 'base64url');
    const supplied = Buffer.from(match[3]!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      return undefined;
    const stored = await this.store.get(match[2]!);
    if (stored === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored) as unknown;
    } catch {
      return undefined;
    }
    return validReference(parsed) && parsed.userId === userId && parsed.expiresAt > this.now()
      ? parsed.supportThreadId
      : undefined;
  }
}

export type StoredSupportResult = Readonly<{
  supportThreadId: string;
  status: 'open' | 'closed';
  unansweredUserMessages: number;
  version: number;
  changedAt: Date;
  replayed: boolean;
}>;

export type UserSupportWrite = Readonly<{
  userId: string;
  supportThreadId: string;
  messageId: string;
  eventId: string;
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  requestDigest: string;
  normalizedText: string;
  expectedVersion?: number;
}>;

export type AdminSupportWrite = Readonly<{
  supportThreadId: string;
  adminUserId: string;
  messageId?: string;
  eventId: string;
  auditId: string;
  commandId: string;
  requestId: string;
  requestDigest: string;
  normalizedText?: string;
  expectedVersion: number;
}>;

export interface SupportStore<TContext = never> {
  open(write: UserSupportWrite): Promise<StoredSupportResult>;
  send(write: UserSupportWrite): Promise<StoredSupportResult>;
  reply(context: TContext, write: AdminSupportWrite): Promise<StoredSupportResult>;
  close(context: TContext, write: AdminSupportWrite): Promise<StoredSupportResult>;
}

type References = Pick<SupportOpaqueReferences, 'issue' | 'resolve'>;

function digest(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function userWrite(
  command: OpenSupportThreadCommand | SendSupportMessageCommand,
  ids: IdGenerator,
  threadId: string,
  normalizedText: string,
): UserSupportWrite {
  return {
    userId: command.actor.userId,
    supportThreadId: threadId,
    messageId: ids.uuid(),
    eventId: ids.uuid(),
    commandId: command.commandId,
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
    requestDigest: digest({
      commandType: command.commandType,
      actorUserId: command.actor.userId,
      ...(command.commandType === 'support.send-message' ? { supportThreadId: threadId } : {}),
      normalizedText,
      ...('expectedVersion' in command.data
        ? { expectedVersion: command.data.expectedVersion }
        : {}),
    }),
    normalizedText,
    ...('expectedVersion' in command.data ? { expectedVersion: command.data.expectedVersion } : {}),
  };
}

async function present(
  result: StoredSupportResult,
  userId: string,
  commandId: string,
  references: References,
): Promise<SupportThreadResult> {
  return {
    supportThreadId: result.supportThreadId,
    supportActionToken: await references.issue(userId, result.supportThreadId, commandId),
    status: result.status,
    unansweredUserMessages: result.unansweredUserMessages,
    version: result.version,
    changedAt: result.changedAt.toISOString(),
    replayed: result.replayed,
  };
}

export class OpenSupportThreadHandler {
  public constructor(
    private readonly store: Pick<SupportStore, 'open'>,
    private readonly references: References,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: OpenSupportThreadCommand): Promise<SupportThreadResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const normalizedText = normalizeSupportText(command.data.text);
    const result = await this.store.open(
      userWrite(command, this.ids, this.ids.uuid(), normalizedText),
    );
    return present(result, command.actor.userId, command.commandId, this.references);
  }
}

export class SendSupportMessageHandler {
  public constructor(
    private readonly store: Pick<SupportStore, 'send'>,
    private readonly references: References,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: SendSupportMessageCommand): Promise<SupportThreadResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const threadId = await this.references.resolve(
      command.data.supportActionToken,
      command.actor.userId,
    );
    if (threadId === undefined)
      throw new ApplicationError('invalid_request', 'error.support.reference_invalid', 400);
    const normalizedText = normalizeSupportText(command.data.text);
    const result = await this.store.send(userWrite(command, this.ids, threadId, normalizedText));
    return present(result, command.actor.userId, command.commandId, this.references);
  }
}

function invalidAdminRequest(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.support.admin_request_invalid', 400);
}

/** Audits every support reply/close attempt in the shared admin-command transaction. */
export class SupportAdminWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly store: Pick<SupportStore<TContext>, 'reply' | 'close'>,
    private readonly ids: IdGenerator,
  ) {}

  public reply(
    attempt: AdminCommandAttempt,
    text: string,
  ): Promise<AdminCommandExecutionResult<StoredSupportResult>> {
    if (
      attempt.commandCode !== 'support.reply-thread' ||
      attempt.requiredPermission !== 'review_support' ||
      attempt.targetType !== 'support_thread' ||
      attempt.expectedTargetVersion === null
    )
      throw invalidAdminRequest();
    const normalizedText = normalizeSupportText(text);
    return this.commands.execute(attempt, async (context) => ({
      value: await this.store.reply(context, {
        supportThreadId: attempt.targetId,
        adminUserId: attempt.adminUserId,
        messageId: this.ids.uuid(),
        eventId: this.ids.uuid(),
        auditId: this.ids.uuid(),
        commandId: attempt.commandId,
        requestId: attempt.requestId,
        requestDigest: attempt.requestDigest,
        normalizedText,
        expectedVersion: attempt.expectedTargetVersion!,
      }),
      safeCode: 'support_replied',
    }));
  }

  public close(
    attempt: AdminCommandAttempt,
  ): Promise<AdminCommandExecutionResult<StoredSupportResult>> {
    if (
      attempt.commandCode !== 'support.close-thread' ||
      attempt.requiredPermission !== 'review_support' ||
      attempt.targetType !== 'support_thread' ||
      attempt.expectedTargetVersion === null
    )
      throw invalidAdminRequest();
    return this.commands.execute(attempt, async (context) => ({
      value: await this.store.close(context, {
        supportThreadId: attempt.targetId,
        adminUserId: attempt.adminUserId,
        eventId: this.ids.uuid(),
        auditId: this.ids.uuid(),
        commandId: attempt.commandId,
        requestId: attempt.requestId,
        requestDigest: attempt.requestDigest,
        expectedVersion: attempt.expectedTargetVersion!,
      }),
      safeCode: 'support_closed',
    }));
  }
}
