import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SubmitAppealCommand, AppealResult } from '@nakh/contracts';
import { ApplicationError, normalizeAppealText, type IdGenerator } from '@nakh/domain';
import type { OpaqueTokenStore } from '../security/opaque-token.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^(v1\.bn\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
const lifetimeSeconds = 24 * 60 * 60;

type BanReferenceState = Readonly<{
  version: 1;
  purpose: 'ban_action';
  userId: string;
  banHistoryId: string;
  expiresAt: number;
}>;

function validReference(value: unknown): value is BanReferenceState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(state).length === 5 &&
    state.version === 1 &&
    state.purpose === 'ban_action' &&
    typeof state.userId === 'string' &&
    UUID.test(state.userId) &&
    typeof state.banHistoryId === 'string' &&
    UUID.test(state.banHistoryId) &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt)
  );
}

/** Opaque, user-bound ban reference; raw history identifiers never cross the client boundary. */
export class BanOpaqueReferences {
  private readonly key: Uint8Array;

  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength < 32) throw new Error('Ban token key is invalid.');
    this.key = Uint8Array.from(key);
  }

  private signature(unsigned: string): string {
    return createHmac('sha256', this.key)
      .update(unsigned)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  private stableId(userId: string, historyId: string, commandId: string): string {
    if (!UUID.test(userId) || !UUID.test(historyId) || !UUID.test(commandId))
      throw new Error('Ban token subject is invalid.');
    return createHmac('sha256', this.key)
      .update(`ban-reference-v1\0${userId}\0${historyId}\0${commandId}`)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  public async issue(userId: string, historyId: string, commandId: string): Promise<string> {
    const id = this.stableId(userId, historyId, commandId);
    const state: BanReferenceState = {
      version: 1,
      purpose: 'ban_action',
      userId,
      banHistoryId: historyId,
      expiresAt: this.now() + lifetimeSeconds * 1000,
    };
    const encoded = JSON.stringify(state);
    if (!(await this.store.putIfAbsent(id, encoded, lifetimeSeconds))) {
      const existing = await this.store.get(id);
      if (existing === undefined) throw new Error('Ban token allocation failed.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing) as unknown;
      } catch {
        throw new Error('Ban token allocation failed.');
      }
      if (
        !validReference(parsed) ||
        parsed.userId !== userId ||
        parsed.banHistoryId !== historyId ||
        parsed.expiresAt <= this.now()
      )
        throw new Error('Ban token allocation failed.');
    }
    const unsigned = `v1.bn.${id}`;
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
      ? parsed.banHistoryId
      : undefined;
  }
}

export type UserAppealWrite = Readonly<{
  userId: string;
  banHistoryId: string;
  appealId: string;
  eventId: string;
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  requestDigest: string;
  normalizedText: string;
}>;
export interface AppealStore {
  currentBan(userId: string): Promise<string | undefined>;
  submit(write: UserAppealWrite): Promise<AppealResult>;
}
export class PrepareAppealHandler {
  public constructor(
    private readonly store: Pick<AppealStore, 'currentBan'>,
    private readonly references: BanOpaqueReferences,
  ) {}
  public async execute(userId: string, commandId: string): Promise<string> {
    const historyId = await this.store.currentBan(userId);
    if (historyId === undefined)
      throw new ApplicationError('conflict', 'error.appeal.unavailable', 409);
    return this.references.issue(userId, historyId, commandId);
  }
}
export class SubmitAppealHandler {
  public constructor(
    private readonly store: Pick<AppealStore, 'submit'>,
    private readonly references: Pick<BanOpaqueReferences, 'resolve'>,
    private readonly ids: IdGenerator,
  ) {}
  public async execute(command: SubmitAppealCommand): Promise<AppealResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const banHistoryId = await this.references.resolve(
      command.data.banActionToken,
      command.actor.userId,
    );
    if (banHistoryId === undefined)
      throw new ApplicationError('invalid_request', 'error.appeal.reference_invalid', 400);
    const normalizedText = normalizeAppealText(command.data.text);
    return this.store.submit({
      userId: command.actor.userId,
      banHistoryId,
      appealId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      commandId: command.commandId,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      normalizedText,
      requestDigest: createHash('sha256')
        .update(JSON.stringify({ userId: command.actor.userId, banHistoryId, normalizedText }))
        .digest('hex'),
    });
  }
}
