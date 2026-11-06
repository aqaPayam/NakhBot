import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AdminCommandAttempt, AdminCommandExecutionResult } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import {
  currentNativeAdminSession,
  inheritNativeAdminSessionPolicy,
  requireNativeAdminTotp,
  type NativeAdminSessionPrincipal,
} from './admin-session-policy.js';
import { PostgresProfileChangeStore } from './profile-change-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUEUE_ID = 'c362e2a4-4765-4fa1-9bbb-dac1d6759ef0';
function unavailable(): never {
  throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function uuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export type ProfileReviewContext = Readonly<{
  principal: NativeAdminSessionPrincipal;
  locale: string;
  expiresAt: Date;
  mfaExpiresAt: Date;
}>;
export type ProfileReviewPosition = Readonly<{ at: string; id: string }>;
export function isProfileReviewPosition(value: unknown): value is ProfileReviewPosition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(row).sort().join(',') !== 'at,id' ||
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    typeof row.at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/u.test(row.at)
  )
    return false;
  const at = new Date(row.at);
  return (
    Number.isFinite(at.getTime()) && at.toISOString() === row.at.replace(/(\.\d{3})\d{3}Z$/u, '$1Z')
  );
}
export type ProfileReviewPage = Readonly<{
  items: ReadonlyArray<
    Readonly<{ id: string; field: 'birth_year' | 'gender'; submittedAt: string }>
  >;
  next: ProfileReviewPosition | undefined;
}>;
export type ProfileReviewBody = Readonly<{
  field: 'birth_year' | 'gender';
  oldValue: string | number;
  requestedValue: string | number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
}>;

/** Authenticates metadata only. Never issues a session or reads a correction body. */
export async function findNativeProfileReviewer(
  database: NakhDatabase,
  telegramUserId: string,
  original?: NativeAdminSessionPrincipal,
): Promise<ProfileReviewContext | undefined> {
  if (!/^[1-9][0-9]{0,19}$/u.test(telegramUserId)) return undefined;
  requireNativeAdminTotp(database);
  return database.transaction().execute(async (tx) => {
    inheritNativeAdminSessionPolicy(database, tx);
    const admin = await tx
      .selectFrom('administration.admin_users')
      .select(['id', 'user_id'])
      .where('telegram_user_id', '=', telegramUserId)
      .where('is_active', '=', true)
      .where('identity_verified_at', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (
      !admin ||
      (original !== undefined &&
        (original.adminUserId !== admin.id ||
          original.actorUserId !== admin.user_id ||
          !UUID.test(original.sessionId)))
    )
      return undefined;
    const sessionId = await currentNativeAdminSession(tx, admin.id, original?.sessionId);
    if (!sessionId) return undefined;
    const permission = await sql<{
      permission_code: string;
    }>`SELECT permission_code FROM administration.lock_runtime_admin_permission(${admin.id}::uuid,'review_change_requests')`.execute(
      tx,
    );
    if (permission.rows[0]?.permission_code !== 'review_change_requests') return undefined;
    const session = (
      await sql<{
        expiresAt: Date;
        mfaExpiresAt: Date;
      }>`SELECT expires_at AS "expiresAt",mfa_expires_at AS "mfaExpiresAt"
      FROM administration.admin_sessions WHERE id=${sessionId}::uuid`.execute(tx)
    ).rows[0]!;
    const settings = await tx
      .selectFrom('identity.user_settings')
      .select('ui_locale_code')
      .where('user_id', '=', admin.user_id)
      .executeTakeFirst();
    if ((await currentNativeAdminSession(tx, admin.id, sessionId)) === undefined) return undefined;
    return {
      principal: { adminUserId: admin.id, actorUserId: admin.user_id, sessionId },
      locale: settings?.ui_locale_code ?? 'en',
      expiresAt: session.expiresAt,
      mfaExpiresAt: session.mfaExpiresAt,
    };
  });
}

/** Native M7 command/audit boundary for the original MFA principal. Private read
 * values exist only in the first committed response, never in replay receipts. */
export class PostgresProfileReviewStore {
  private readonly principal: NativeAdminSessionPrincipal;
  public constructor(
    private readonly database: NakhDatabase,
    principal: NativeAdminSessionPrincipal,
  ) {
    this.principal = Object.freeze({
      adminUserId: principal.adminUserId,
      actorUserId: principal.actorUserId,
      sessionId: principal.sessionId,
    });
    if (
      ![principal.adminUserId, principal.actorUserId, principal.sessionId].every((v) =>
        UUID.test(v),
      )
    )
      unavailable();
    requireNativeAdminTotp(database);
  }
  private async lockCurrentTarget(tx: NakhDatabase, requestId: string): Promise<void> {
    const reference = await tx
      .selectFrom('profile.profile_change_requests')
      .select('user_id')
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!reference) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    await tx
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', reference.user_id)
      .forNoKeyUpdate()
      .execute();
    await tx
      .selectFrom('identity.accounts')
      .select('user_id')
      .where('user_id', '=', reference.user_id)
      .forUpdate()
      .execute();
    const current = await sql<{
      allowed: boolean;
    }>`SELECT profile.change_is_current(${requestId}::uuid,${reference.user_id}::uuid) AS allowed`.execute(
      tx,
    );
    if (current.rows[0]?.allowed !== true)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
  }
  private attempt(
    operationId: string,
    kind: 'list' | 'read' | 'review',
    targetId: string,
    data: unknown,
  ): AdminCommandAttempt {
    if (operationId.length < 8 || operationId.length > 128 || !UUID.test(targetId))
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const key = JSON.stringify(['profile-review', this.principal, operationId]);
    return {
      logId: randomUUID(),
      adminUserId: this.principal.adminUserId,
      commandId: uuid(key),
      requestId: uuid(key + ':request'),
      requestDigest: digest({ kind, targetId, data }),
      commandCode:
        kind === 'list'
          ? 'profile.list-change-requests'
          : kind === 'read'
            ? 'profile.reveal-change-request'
            : 'profile.review-change-request',
      requiredPermission: 'review_change_requests',
      targetType: kind === 'list' ? 'profile_change_queue' : 'profile_change_request',
      targetId,
      expectedTargetVersion: null,
      reasonDigest: digest('profile-correction-review'),
      metadata: {},
      correlationId: uuid(key + ':request'),
    };
  }
  private async execute<T>(
    attempt: AdminCommandAttempt,
    effect: (tx: NakhDatabase) => Promise<T>,
  ): Promise<AdminCommandExecutionResult<T>> {
    return new PostgresAdminCommandStore(this.database, this.principal).execute(
      attempt,
      async (tx) => ({ value: await effect(tx), safeCode: 'profile_change_processed' }),
      async (tx, outcome) => {
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id: randomUUID(),
            category: 'admin',
            event_type: attempt.commandCode + '.v1',
            actor_type: 'admin',
            actor_user_id: null,
            actor_admin_id: this.principal.adminUserId,
            subject_type: attempt.targetType,
            subject_id: attempt.targetId,
            result_code: outcome.result,
            metadata_schema_version: 1,
            metadata: { actionType: 'profile_correction', decision: outcome.result },
            command_id: attempt.commandId,
            request_id: attempt.requestId,
            occurred_at: outcome.recordedAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      },
      attempt.targetType === 'profile_change_request'
        ? (tx) => this.lockCurrentTarget(tx, attempt.targetId)
        : undefined,
    );
  }
  public list(
    operationId: string,
    input?: ProfileReviewPosition,
  ): Promise<AdminCommandExecutionResult<ProfileReviewPage>> {
    const after = input === undefined ? undefined : Object.freeze({ ...input });
    if (after && !isProfileReviewPosition(after))
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const attempt = this.attempt(operationId, 'list', QUEUE_ID, after ?? null);
    return this.execute(attempt, async (tx) => {
      let query = tx
        .selectFrom('profile.profile_change_requests as request')
        .select(['request.id', 'request.field_name', 'request.submitted_at'])
        .select(
          sql<string>`to_char(request.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'cursor_at',
          ),
        )
        .where('request.status', '=', 'pending')
        .where(sql<boolean>`profile.change_is_current(request.id,request.user_id)`);
      if (after)
        query = query.where((eb) =>
          eb.or([
            eb('request.submitted_at', '>', sql<Date>`${after.at}::timestamptz`),
            eb.and([
              eb('request.submitted_at', '=', sql<Date>`${after.at}::timestamptz`),
              eb('request.id', '>', after.id),
            ]),
          ]),
        );
      const rows = await query
        .orderBy('request.submitted_at')
        .orderBy('request.id')
        .limit(11)
        .execute();
      const items = rows.slice(0, 10),
        last = items.at(-1);
      return {
        items: items.map((row) => ({
          id: row.id,
          field: row.field_name,
          submittedAt: row.submitted_at.toISOString(),
        })),
        next: rows.length > 10 && last ? { at: last.cursor_at, id: last.id } : undefined,
      };
    });
  }
  public read(
    operationId: string,
    requestId: string,
  ): Promise<AdminCommandExecutionResult<ProfileReviewBody>> {
    const attempt = this.attempt(operationId, 'read', requestId, null);
    return this.execute(attempt, async (tx) => {
      await this.lockCurrentTarget(tx, requestId);
      const row = await tx
        .selectFrom('profile.profile_change_requests')
        .selectAll()
        .where('id', '=', requestId)
        .forShare()
        .executeTakeFirstOrThrow();
      return {
        field: row.field_name,
        oldValue: row.old_value_snapshot,
        requestedValue: row.requested_value,
        reason: row.reason,
        status: row.status,
      };
    });
  }
  public review(
    operationId: string,
    requestId: string,
    decision: 'approved' | 'rejected',
  ): Promise<
    AdminCommandExecutionResult<
      Readonly<{ decision: 'approved' | 'rejected'; profileVersion: number }>
    >
  > {
    if (decision !== 'approved' && decision !== 'rejected')
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const attempt = this.attempt(operationId, 'review', requestId, decision);
    return this.execute(attempt, async (tx) => {
      const at = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx)).rows[0]!.at;
      const result = await new PostgresProfileChangeStore(
        tx,
        undefined,
        this.principal,
      ).resolveProtectedChange({
        command: {
          commandId: attempt.commandId,
          requestId: attempt.requestId,
          commandType: 'profile.resolve-protected-change',
          schemaVersion: 1,
          actor: { kind: 'admin', userId: this.principal.actorUserId },
          idempotencyKey: attempt.commandId,
          occurredAt: at.toISOString(),
          locale: 'en',
          data: { profileChangeRequestId: requestId, decision },
        },
        authorization: {
          adminUserId: this.principal.adminUserId,
          reviewerUserId: this.principal.actorUserId,
        },
        normalizedNote: undefined,
        auditId: randomUUID(),
        eventId: randomUUID(),
        processedAt: at,
      });
      return { decision: result.decision, profileVersion: result.profileVersion };
    });
  }
}
