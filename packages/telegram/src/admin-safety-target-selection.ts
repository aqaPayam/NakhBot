import { createHmac } from 'node:crypto';
import type {
  OpaqueTokenStore,
  PrepareSupportActionHandler,
  PrepareAppealReviewAccessHandler,
} from '@nakh/application';
import { ApplicationError, normalizeAdminReason } from '@nakh/domain';
import type { TelegramAdminSafetyReadPreparation } from './admin-safety-read-preparation.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record } from './m7-private-update.js';

export type TelegramSafetyTargetSelection = Readonly<{
  kind: 'support' | 'appeal';
  queueActionToken: string;
  targetId: string;
  expectedVersion: number;
  reason: string;
  /** Server-owned operation identity and authenticated provider timestamp, stable on retry. */
  operationId: string;
  occurredAt: string;
}>;

/** Trusted metadata selection boundary, not a client-selected actor or permission. Native
 * selection checks current queue authority and target version on every attempt. The content-free
 * receipt retains its first opaque target action; the read vault alone retains encrypted prose. */
export class TelegramAdminSafetyTargetSelection {
  private readonly key: Uint8Array;
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly support: Pick<PrepareSupportActionHandler, 'execute'>,
    private readonly appeals: Pick<PrepareAppealReviewAccessHandler, 'execute'>,
    private readonly tokens: OpaqueTokenStore,
    key: Uint8Array,
    private readonly reads: Pick<TelegramAdminSafetyReadPreparation, 'prepare'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (key.byteLength < 32) throw new Error('Admin selection configuration invalid.');
    this.key = Uint8Array.from(key);
  }
  private digest(value: unknown): Buffer {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['telegram-admin-target-selection-v1', value]))
      .digest();
  }
  public async select(
    telegramUserId: string,
    selected: TelegramSafetyTargetSelection,
  ): Promise<string> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      const actor = { kind: 'admin' as const, userId: session.actor.userId };
      const reason = normalizeAdminReason(selected.reason);
      const instant = Date.parse(selected.occurredAt);
      if (
        !['support', 'appeal'].includes(selected.kind) ||
        !/^[A-Za-z0-9:_-]{1,128}$/u.test(selected.operationId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          selected.targetId,
        ) ||
        !/^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(selected.queueActionToken) ||
        !Number.isSafeInteger(selected.expectedVersion) ||
        selected.expectedVersion < 1 ||
        !Number.isFinite(instant) ||
        new Date(instant).toISOString() !== selected.occurredAt
      )
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const identity = this.digest([session.actor.userId, selected.operationId]);
      const bytes = Buffer.from(identity.subarray(0, 16));
      bytes[6] = (bytes[6]! & 15) | 0x50;
      bytes[8] = (bytes[8]! & 63) | 0x80;
      const hex = bytes.toString('hex');
      const commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const binding = this.digest([
        session.actor.userId,
        session.locale,
        selected.kind,
        selected.queueActionToken,
        selected.targetId,
        selected.expectedVersion,
        reason,
        selected.occurredAt,
      ]).toString('base64url');
      // Always call native selection before recovering a receipt: cached UI state grants no authority.
      const action =
        selected.kind === 'support'
          ? await this.support.execute(
              {
                actor,
                requestId: commandId,
                adminActionToken: selected.queueActionToken,
                threadId: selected.targetId,
                expectedThreadVersion: selected.expectedVersion,
                action: 'reveal',
              },
              session.actor,
            )
          : await this.appeals.execute(
              {
                actor,
                requestId: commandId,
                adminActionToken: selected.queueActionToken,
                appealId: selected.targetId,
                expectedAppealVersion: selected.expectedVersion,
                action: 'reveal',
              },
              session.actor,
            );
      const version = 'threadVersion' in action ? action.threadVersion : action.appealVersion;
      if (
        version !== selected.expectedVersion ||
        !/^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(action.adminActionToken)
      )
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      const cacheKey = `telegram-admin-target-selection:${identity.toString('base64url')}`;
      const expiresAt = this.now().getTime() + 300000;
      if (!Number.isSafeInteger(expiresAt))
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      await this.tokens.putIfAbsent(
        cacheKey,
        JSON.stringify({
          binding,
          adminActionToken: action.adminActionToken,
          version,
          expiresAt,
        }),
        300,
      );
      const encoded = await this.tokens.get(cacheKey);
      if (encoded === undefined || encoded.length > 1024)
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      const stored = m7Record(JSON.parse(encoded) as unknown);
      if (
        stored === undefined ||
        Object.keys(stored).length !== 4 ||
        typeof stored.binding !== 'string' ||
        typeof stored.expiresAt !== 'number' ||
        !Number.isSafeInteger(stored.expiresAt) ||
        stored.expiresAt <= this.now().getTime() ||
        typeof stored.version !== 'number' ||
        !Number.isSafeInteger(stored.version) ||
        stored.version < 1 ||
        typeof stored.adminActionToken !== 'string' ||
        !/^v1\.ad\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(stored.adminActionToken)
      )
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      if (stored.binding !== binding)
        throw new ApplicationError('idempotency_conflict', 'error.m7.stale_action', 409);
      if (stored.version !== selected.expectedVersion)
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, session.actor);
      const base = {
        actor,
        commandId,
        requestId: commandId,
        idempotencyKey: commandId,
        schemaVersion: 1 as const,
        occurredAt: selected.occurredAt,
        locale: session.locale,
        data: {
          adminActionToken: stored.adminActionToken,
          expectedTargetVersion: selected.expectedVersion,
          reason,
        },
      };
      return await this.reads.prepare(
        telegramUserId,
        selected.kind === 'support'
          ? { kind: 'support', command: { ...base, commandType: 'support.reveal-thread' } }
          : { kind: 'appeal', command: { ...base, commandType: 'moderation.reveal-appeal' } },
        identity.subarray(0, 16).toString('base64url'),
      );
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
